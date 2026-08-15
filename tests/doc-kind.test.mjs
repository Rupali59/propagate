/**
 * Doc kind and supersession.
 *
 * Kind sets the staleness rule — a `plan` going quiet is correct, a `page-spec` going
 * quiet is a defect — so getting kind wrong makes every downstream check wrong.
 *
 * The precedence test is the load-bearing one. Inference must be a DEFAULT and never an
 * override: a doc that declares `kind:` has been classified by a human, and a path
 * heuristic must not out-vote them. A first classifier in this tree put Motherboard's
 * `docs/sdk/*.md` — its most valuable backend specs — into "unclassified" purely because
 * they matched no naming convention. Declaration is the escape hatch from exactly that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  kindOf,
  parseSupersedes,
  proseOnlySupersession,
  buildSupersessionIndex,
  brokenPathCitations,
  frontmatter,
  KINDS,
} from "../lib/doc-kind.mjs";

async function tree() {
  const root = await mkdtemp(path.join(tmpdir(), "dockind-"));
  await mkdir(path.join(root, "docs", "plans"), { recursive: true });
  await mkdir(path.join(root, "docs", "content", "legal"), { recursive: true });
  await mkdir(path.join(root, "docs", "sdk"), { recursive: true });
  const w = (rel, body) => writeFile(path.join(root, rel), body, "utf8");
  await w("docs/DECISIONS.md", "# Decisions\n");
  await w("docs/README.md", "# Router\n");
  await w("docs/plans/2026-06-20-a-thing.md", "# Plan\n");
  await w("docs/content/legal/PRIVACY-CONTENT.md", "# Privacy spec\n");
  await w("docs/sdk/auth-model.md", "# Auth model\n");
  await w("docs/V1-SURFACE.md", "# Locked surface\n"); // residue: no convention matches
  return root;
}

test("tier 1 — filename conventions resolve, and say they came from the filename", async () => {
  const root = await tree();
  assert.deepEqual(kindOf(path.join(root, "docs/DECISIONS.md")), {
    kind: "decision-log", source: "filename", supersedes: [],
  });
  assert.equal(kindOf(path.join(root, "docs/plans/2026-06-20-a-thing.md")).kind, "plan");
  assert.equal(kindOf(path.join(root, "docs/README.md")).kind, "router");
});

test("tier 2 — directory conventions resolve", async () => {
  const root = await tree();
  assert.equal(kindOf(path.join(root, "docs/content/legal/PRIVACY-CONTENT.md")).kind, "page-spec");
  assert.equal(kindOf(path.join(root, "docs/sdk/auth-model.md")).kind, "functionality-spec");
  assert.equal(kindOf(path.join(root, "docs/sdk/auth-model.md")).source, "directory");
});

test("the residue reports `undeclared` — a value, never a silence", async () => {
  const root = await tree();
  const r = kindOf(path.join(root, "docs/V1-SURFACE.md"));
  assert.equal(r.kind, null);
  assert.equal(r.source, "undeclared", "must name WHY it has no kind, not just return null");
});

test("PRECEDENCE — frontmatter beats inference, and must never reverse", async () => {
  const root = await tree();
  // A file in docs/plans/ with a date: inference says `plan`. The author says otherwise.
  const p = path.join(root, "docs/plans/2026-06-20-a-thing.md");
  await writeFile(p, "---\nkind: functionality-spec\n---\n\n# Actually a spec\n", "utf8");
  const r = kindOf(p);
  assert.equal(r.kind, "functionality-spec", "declaration must out-vote the path heuristic");
  assert.equal(r.source, "frontmatter");
});

test("supersedes parses a list or a scalar, with anchors preserved", () => {
  assert.deepEqual(parseSupersedes("[../a.md, ../b.md#2026-06-21]"), ["../a.md", "../b.md#2026-06-21"]);
  assert.deepEqual(parseSupersedes("../solo.md"), ["../solo.md"]);
  assert.deepEqual(parseSupersedes(undefined), []);
  assert.deepEqual(parseSupersedes(""), []);
});

test("prose-only supersession is flagged — this is the 75-instance case", async () => {
  const root = await tree();
  const p = path.join(root, "docs/plans/2026-06-20-a-thing.md");
  await writeFile(p, "# Plan\n\nSupersedes the 2026-06-14 Vipin lock.\n", "utf8");
  const hit = proseOnlySupersession(p);
  assert.ok(hit, "a prose supersession claim with no declaration must be flagged");
  assert.equal(hit.hits.length, 1);
  assert.match(hit.hits[0].text, /Supersedes the 2026-06-14/);
});

test("declaring it silences the prose check — a check that cannot go quiet measures nothing", async () => {
  const root = await tree();
  const p = path.join(root, "docs/plans/2026-06-20-a-thing.md");
  await writeFile(p, "---\nsupersedes: [../DECISIONS.md#2026-06-14]\n---\n\nSupersedes the lock.\n", "utf8");
  assert.equal(proseOnlySupersession(p), null);
});

test("supersession inverts — the superseded doc is never edited", async () => {
  const root = await tree();
  const spec = path.join(root, "docs/content/legal/PRIVACY-CONTENT.md");
  await writeFile(spec, "---\nkind: page-spec\nsupersedes: [../../DECISIONS.md#2026-06-21]\n---\n\n# Privacy\n", "utf8");

  const idx = buildSupersessionIndex([spec]);
  const decisions = path.resolve(root, "docs/DECISIONS.md");
  assert.ok(idx.has(decisions), "the decision log must be discoverable as overruled");
  assert.equal(idx.get(decisions)[0].anchor, "2026-06-21", "the anchor identifies WHICH entry");
  assert.match(idx.get(decisions)[0].by, /PRIVACY-CONTENT\.md$/);
});

test("frontmatter absent is not an error, and every KIND documents its lifecycle", () => {
  assert.equal(frontmatter("# no frontmatter\n"), null);
  for (const [k, why] of Object.entries(KINDS)) {
    assert.ok(why.length > 10, `${k} must state the lifecycle it implies, not just exist`);
  }
});

test("broken-path citations: narrow by design, because the naive rule was 12x noise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dockind-paths-"));
  await mkdir(path.join(root, "lib"), { recursive: true });
  await writeFile(path.join(root, "lib", "real.ts"), "export const x = 1;\n", "utf8");
  const doc = path.join(root, "GUIDE.md");
  await writeFile(
    doc,
    [
      "Cites a real file: `lib/real.ts`",
      "Cites a dead file: `lib/gone.ts`",
      "Cites a dead dir:  `lib/nowhere/`",
      // Each of the following defeated the first version of this check, which reported
      // 603 findings across 6 projects. None is a path.
      "A git branch:      `feat/hero-v4-rebuild`",
      "A git tag:         `archive/main-2026-05-22`",
      "A CIDR block:      `0.0.0.0/0`",
      "A module import:   `next/image`",
    ].join("\n"),
    "utf8",
  );

  const broken = brokenPathCitations(doc, [root]);
  assert.deepEqual(
    broken.sort(),
    ["lib/gone.ts", "lib/nowhere/"],
    "must catch the two dead paths and NONE of the branch/tag/CIDR/module lookalikes",
  );
});

test("a path resolving against the workspace root is not broken", async () => {
  // `docs/constitution/VIPIN.md` is correct from the WORKSPACE root and absent from the
  // project root. Resolving against only one of them called 9 such citations broken.
  const ws = await mkdtemp(path.join(tmpdir(), "dockind-ws-"));
  const proj = path.join(ws, "project");
  await mkdir(path.join(ws, "docs"), { recursive: true });
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(ws, "docs", "VIPIN.md"), "# constitution\n", "utf8");
  const doc = path.join(proj, "CLAUDE.md");
  await writeFile(doc, "See `docs/VIPIN.md`\n", "utf8");

  assert.deepEqual(brokenPathCitations(doc, [proj, ws]), [], "workspace-root resolution must count");
  assert.deepEqual(brokenPathCitations(doc, [proj]), ["docs/VIPIN.md"], "and without it, it reads as broken");
});

test("an unreadable doc returns null — not an empty array that reads as clean", () => {
  assert.equal(brokenPathCitations(path.join(tmpdir(), "definitely-absent-xyz.md"), ["/"]), null);
});
