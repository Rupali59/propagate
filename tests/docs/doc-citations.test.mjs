/**
 * A path a doc cites must resolve, or the citation is a claim nobody can check.
 *
 * FOUND 2026-08-20, caused by my own restructure: `docs/GOTCHAS.md` G12 carried
 * `**Guarded by:** tests/config-state-dir.test.mjs`, which had moved to
 * `tests/portability/`. 32 such citations across GOTCHAS, ISSUES and DATA_MODEL pointed
 * at files that no longer existed. A `Guarded by:` line that does not resolve is worse
 * than an absent one: it asserts coverage while naming nothing.
 *
 * rule:adversarial-review-reads-the-ledger — a declaration nothing tests is the same
 * failure in a new place. So this is the test, not a note asking someone to look.
 *
 * APPEND-ONLY FILES ARE EXCLUDED BY NAME, not by accident. docs/DECISIONS.md and
 * docs/AUDIT-2026-08.md are historical records; rule:state-and-decisions forbids editing
 * past entries, and their citations are evidence of what was true when written. The
 * 2026-08-20 DECISIONS entry carries the old→new map for readers of those.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Historical records. Their citations are evidence and are never rewritten. */
const APPEND_ONLY = new Set(["DECISIONS.md", "AUDIT-2026-08.md"]);

/** `tests/x.test.mjs` appears in prose as a generic placeholder, not a real file. */
const PLACEHOLDERS = new Set(["tests/x.test.mjs"]);

function currentDocs() {
  const out = [];
  for (const f of readdirSync(path.join(REPO, "docs"))) {
    if (f.endsWith(".md") && !APPEND_ONLY.has(f)) out.push(path.join("docs", f));
  }
  return [...out, "SKILL.md", "STATE.md"];
}

test("every tests/… path cited in a current doc resolves", () => {
  const docs = currentDocs();
  assert.ok(docs.length > 5, `expected a populated doc list, got ${docs.length}`);

  const broken = [];
  for (const rel of docs) {
    const abs = path.join(REPO, rel);
    if (!existsSync(abs)) continue;
    const body = readFileSync(abs, "utf8");
    for (const m of body.matchAll(/\btests\/[A-Za-z0-9._/-]+\.test\.mjs/g)) {
      const cited = m[0];
      if (PLACEHOLDERS.has(cited)) continue;
      if (!existsSync(path.join(REPO, cited))) broken.push(`${rel} → ${cited}`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    "these citations name files that do not exist:\n  " + broken.join("\n  "),
  );
});

test("every `Guarded by:` citation in GOTCHAS names something that exists", () => {
  // Moved to propagation/state/workspace/ 2026-08-23; the legacy path is kept so
  // an older checkout still resolves rather than silently reading nothing.
  const gotchasPath = [
    path.join(REPO, "propagation", "state", "workspace", "GOTCHAS.md"),
    path.join(REPO, "docs", "GOTCHAS.md"),
  ].find((c) => existsSync(c));
  assert.ok(gotchasPath, "GOTCHAS.md not found at either location — a missing file is not zero citations");
  const body = readFileSync(gotchasPath, "utf8");
  const claims = [...body.matchAll(/^\*\*Guarded by:\*\* `([^`]+)`/gm)].map((m) => m[1]);
  assert.ok(claims.length > 0, "no Guarded by: claims parsed — the regex or the file shape changed");

  const broken = claims.filter((c) => {
    const p = c.split(/[\s:]/)[0]; // strip a trailing :line-range or trailing prose
    // A bare identifier (a function name) is not a path; only path-shaped claims are
    // checkable here, and claiming otherwise would make this test fire on prose.
    if (!p.includes("/") && !p.endsWith(".mjs")) return false;
    return !existsSync(path.join(REPO, p));
  });

  assert.deepEqual(broken, [], `Guarded by: claims naming missing files:\n  ${broken.join("\n  ")}`);
});
