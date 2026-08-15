/**
 * Doc authority — the three failure cases are the tests, and all three are real.
 *
 * 2026-08-15, in this tree:
 *   1. `app/(site)/privacy/page.tsx` was rewritten without reading
 *      `docs/content/legal/PRIVACY-CONTENT.md`, the 515-line spec that governs it and is
 *      marked "Part 1 · verbatim · owner: Clients · counsel". The edit was reverted.
 *   2. That spec supersedes a decision the decision log still presents as current.
 *   3. `TurnstileWidget.tsx` is live and receives visitor IP; the spec that must disclose
 *      processors never mentions Turnstile. NEITHER FILE CHANGED — no drift check can
 *      ever fire on this, which is why coverage is a separate primitive.
 *
 * Case 1 is the load-bearing one: before this feature the edit proceeded silently, so the
 * first assertion below is that an UNdeclared file is not blocked. A guard that blocks
 * everything is as useless as one that blocks nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAuthorityIndex,
  whatGoverns,
  blocks,
  checkCoverage,
  formatGoverned,
  AUTHORITY_LEVELS,
} from "../lib/docs.mjs";

/** Mirrors the real shape: spec under docs/, renderer under app/, one sidecar at root. */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "docauth-"));
  await mkdir(path.join(root, "docs", "content", "legal"), { recursive: true });
  await mkdir(path.join(root, "app", "(site)", "privacy"), { recursive: true });
  await mkdir(path.join(root, "components"), { recursive: true });

  await writeFile(
    path.join(root, "docs", "content", "legal", "PRIVACY-CONTENT.md"),
    "# Privacy Notice — content spec\n\nPart 1 is the published notice, verbatim.\n",
    "utf8",
  );
  await writeFile(path.join(root, "app", "(site)", "privacy", "page.tsx"), "export default 1;\n", "utf8");
  await writeFile(path.join(root, "components", "TurnstileWidget.tsx"), "export const T = 1;\n", "utf8");
  await writeFile(path.join(root, "app", "(site)", "privacy", "unrelated.tsx"), "export default 2;\n", "utf8");

  await writeFile(
    path.join(root, ".propagates.yml"),
    [
      "workspace: true",
      "sources:",
      "  docs/content/legal/PRIVACY-CONTENT.md:",
      "    propagates_to:",
      '      - path: "app/(site)/privacy/page.tsx"',
      '        why: "Part 1 is the published notice, verbatim"',
      "        kind: prose",
      "        authority: counsel",
      "  docs/content/legal/REFUNDS-CONTENT.md:",
      "    propagates_to:",
      '      - path: "app/(site)/privacy/unrelated.tsx"',
      '        why: "background only"',
      "        kind: prose",
      "        authority: reference",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

test("case 1 — a counsel-governed file is identified and blocks", async () => {
  const root = await fixture();
  const index = buildAuthorityIndex([path.join(root, ".propagates.yml")]);
  const target = path.join(root, "app", "(site)", "privacy", "page.tsx");

  const res = whatGoverns(target, index);
  assert.equal(res.governed, true, "the edge is declared; this file must resolve as governed");
  assert.equal(res.hits[0].authority, "counsel");
  assert.ok(blocks(res.hits[0].authority), "counsel must block — this is the whole point");
  assert.match(res.hits[0].source, /PRIVACY-CONTENT\.md$/, "must name the governing spec by path");
  assert.match(formatGoverned(target, res), /BLOCKING/);
});

test("an ungoverned file is NOT blocked, and says why it is ungoverned", async () => {
  const root = await fixture();
  const index = buildAuthorityIndex([path.join(root, ".propagates.yml")]);
  // A guard that blocks everything is as useless as one that blocks nothing.
  const res = whatGoverns(path.join(root, "components", "TurnstileWidget.tsx"), index);
  assert.equal(res.governed, false);
  // Absence must be attributable — never a bare empty result (rule:discernment-checks §2).
  assert.ok(res.reason && res.reason.length > 0, "must state WHY it is ungoverned");
  assert.match(formatGoverned("x/TurnstileWidget.tsx", res), /ungoverned —/);
});

test("advisory levels do not block", async () => {
  const root = await fixture();
  const index = buildAuthorityIndex([path.join(root, ".propagates.yml")]);
  const res = whatGoverns(path.join(root, "app", "(site)", "privacy", "unrelated.tsx"), index);
  assert.equal(res.governed, true);
  assert.equal(res.hits[0].authority, "reference");
  assert.equal(blocks("reference"), false);
  assert.equal(blocks("spec"), false);
});

test("case 3 — coverage flags a live artifact its governing doc never mentions", async () => {
  const root = await fixture();
  const spec = path.join(root, "docs", "content", "legal", "PRIVACY-CONTENT.md");

  const uncovered = checkCoverage([
    { name: "Turnstile", doc: spec, artifacts: [path.join(root, "components", "TurnstileWidget.tsx")] },
  ]);
  assert.equal(uncovered.length, 1);
  assert.equal(uncovered[0].covered, false, "the spec does not mention Turnstile — must be flagged");

  // And it must go quiet once disclosed. A coverage check that cannot go quiet is not
  // measuring anything.
  await writeFile(spec, "# Privacy\n\nCloudflare Turnstile runs on the booking form.\n", "utf8");
  const after = checkCoverage([
    { name: "Turnstile", doc: spec, artifacts: [path.join(root, "components", "TurnstileWidget.tsx")] },
  ]);
  assert.equal(after[0].covered, true, "must go quiet once the doc covers it");
});

test("coverage ignores artifacts that are not present — absent is not undisclosed", async () => {
  const root = await fixture();
  const res = checkCoverage([
    {
      name: "Recaptcha",
      doc: path.join(root, "docs", "content", "legal", "PRIVACY-CONTENT.md"),
      artifacts: [path.join(root, "components", "DoesNotExist.tsx")],
    },
  ]);
  assert.equal(res.length, 0, "a processor that is not in use has nothing to disclose");
});

test("authority levels are ordered most-binding-first, and only counsel blocks", () => {
  assert.deepEqual(AUTHORITY_LEVELS, ["counsel", "spec", "reference"]);
  assert.equal(AUTHORITY_LEVELS.filter(blocks).length, 1);
});
