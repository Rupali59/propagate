/**
 * Cross-filed work: open items and recently-resolved entries that live in SOMEONE
 * ELSE'S register but name this workspace.
 *
 * WHAT THIS CLOSES. Attribution elsewhere in the rollup is `nearestOwner`, keyed on
 * the item's FILE PATH — right for "whose register is this", wrong for "who is this
 * ABOUT". An issue concerning `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh` filed
 * in propagate's ISSUES.md is attributed to propagate, so nobody standing in Vipin
 * Kaushik ever sees it. And when it is RESOLVED, that workspace still learns
 * nothing: `backlog()` returns OPEN items only, so no existing view could carry it.
 *
 * NOTHING IS COPIED, and the tests assert that shape rather than the wording: these
 * are derivations over data already walked, recomputed on every regeneration of a
 * file that is itself derived. `backlog.mjs` records the standing refusal — "Copying
 * issues downward would create a second register to keep in sync" — and it still
 * holds. A copy has to be closed twice; this cannot be closed at all.
 *
 * THE MATCHER IS PATH-SHAPED, AND THAT IS THE POINT OF HALF THIS FILE. The first
 * implementation used `affectsMatcher`'s bare substring test and produced, on the
 * live tree: Rupali 75, propagate 46, Tathya 39, Motherboard 35. "Rupali" is the
 * author's name and appears in nearly every entry; "propagate" is both the tool and
 * an ordinary verb. Publishing those would have made the rollup's least reliable
 * number its most prominent one. Path-shaped matching took the same tree to
 * Rupali 5, propagate 11, Tathya 8, Motherboard 6.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { crossFiledByOwner, resolvedElsewhereByOwner, RESOLVED_WINDOW_DAYS } from "../../lib/report/rollup.mjs";

const OWNERS = [
  { key: "Vipin Kaushik", name: "Vipin Kaushik" },
  { key: "Rupali", name: "Rupali" },
  { key: "propagate", name: "propagate" },
];

/** `bodiesByItem` keys on the ITEM OBJECT, so fixtures must be stable references. */
function itemsFrom(spec) {
  return spec.map((s, i) => ({ id: `i${i}`, file: s.file, text: s.text, sources: s.sources ?? [] }));
}

test("an item filed elsewhere that names a workspace by PATH is attributed to it", () => {
  const ranked = itemsFrom([
    { file: "/hub/propagate/propagation/state/workspace/ISSUES.md", text: "N53 · the size-cap check reads the pre-move path" },
  ]);
  // The heading never names the workspace — the BODY does. This is why body
  // matching is required and not belt-and-braces.
  const readFile = () => "N53 · the size-cap check reads the pre-move path\nIt reads Vipin Kaushik/scripts/hygiene/lib/size-caps.sh at the old location.\n";
  const out = crossFiledByOwner({ ranked }, OWNERS, readFile);
  assert.equal(out.get("Vipin Kaushik").length, 1, "the workspace the item is ABOUT must see it");
  assert.equal(out.get("propagate").length, 0, "the register's own owner files it HERE, not elsewhere");
});

test("a bare word mention does NOT count — only a path-shaped reference", () => {
  const ranked = itemsFrom([
    { file: "/hub/propagate/propagation/state/workspace/ISSUES.md", text: "some entry" },
  ]);
  // Exactly the shape that produced Rupali=75: her name in ordinary prose.
  const readFile = () => "some entry\nRupali asked for this and Rupali's call was to defer it. Rupali agreed.\n";
  const out = crossFiledByOwner({ ranked }, OWNERS, readFile);
  assert.equal(
    out.get("Rupali").length,
    0,
    "three prose mentions of a name are not a cross-filed item — this is the 75-to-5 regression",
  );
});

test("a path-shaped reference to that same name DOES count", () => {
  const ranked = itemsFrom([{ file: "/hub/propagate/x/ISSUES.md", text: "e" }]);
  const readFile = () => "e\nbroken: Rupali/Obsidian/Scripts/config.json is gitignored\n";
  const out = crossFiledByOwner({ ranked }, OWNERS, readFile);
  assert.equal(out.get("Rupali").length, 1, "a real path must still be found");
});

test("an item living in the owner's own tree is never 'elsewhere', even if its body names it", () => {
  const ranked = itemsFrom([
    { file: "/hub/Vipin Kaushik/propagation/state/workspace/ISSUES.md", text: "own entry" },
  ]);
  const readFile = () => "own entry\nabout Vipin Kaushik/scripts/thing.sh\n";
  const out = crossFiledByOwner({ ranked }, OWNERS, readFile);
  assert.equal(out.get("Vipin Kaushik").length, 0, "filed HERE — already in that workspace's own Open items");
});

test("a body read that throws degrades to path matching, never to a crash", () => {
  const ranked = itemsFrom([{ file: "/hub/propagate/x/ISSUES.md", text: "t" }]);
  const readFile = () => { throw new Error("EACCES"); };
  const out = crossFiledByOwner({ ranked }, OWNERS, readFile);
  assert.ok(out instanceof Map, "must return a result, not throw — a rollup dies for nothing here");
  assert.equal(out.get("Vipin Kaushik").length, 0);
});

test("empty inputs return a fully-populated map, never a bare empty one", () => {
  const out = crossFiledByOwner({ ranked: [] }, OWNERS, () => "");
  assert.deepEqual([...out.keys()].sort(), ["Rupali", "Vipin Kaushik", "propagate"]);
  // Every owner present with an empty list: "we looked and found none" must be
  // representable, and distinct from an owner simply being absent from the map.
  for (const v of out.values()) assert.deepEqual(v, []);
});

// ── resolved-elsewhere ──────────────────────────────────────────────────────

const RESOLVED_FILE = "/hub/propagate/propagation/state/workspace/ISSUES.md";
const RESOLVED_TEXT = [
  "### N56 · pointer stub read as live — **S1** — **RESOLVED 2026-08-28**",
  "",
  "Affected Keerti/propagation/state/workspace/STATE.md among others.",
  "",
  "### N10 · something old — **S2** — **RESOLVED 2020-01-01**",
  "",
  "Also touched Keerti/something.md long ago.",
  "",
  "### N11 · undated closure — **S3** — **RESOLVED**",
  "",
  "Touched Keerti/undated.md with no date in the heading.",
  "",
  "### N12 · still open — **S2** — **OPEN**",
  "",
  "Concerns Keerti/open.md and must not appear.",
].join("\n");

const K = [{ key: "Keerti", name: "Keerti" }];
const NOW = new Date("2026-09-01T00:00:00Z");

test("a recently resolved entry elsewhere reaches the workspace it names", () => {
  const out = resolvedElsewhereByOwner(
    { issueFiles: [{ file: RESOLVED_FILE }] }, K, NOW, () => RESOLVED_TEXT,
  );
  const got = out.get("Keerti");
  assert.equal(got.dated.length, 1, "exactly the in-window one");
  assert.equal(got.dated[0].resolvedISO, "2026-08-28");
});

test("an OPEN entry is never reported as resolved", () => {
  const out = resolvedElsewhereByOwner(
    { issueFiles: [{ file: RESOLVED_FILE }] }, K, NOW, () => RESOLVED_TEXT,
  );
  const all = [...out.get("Keerti").dated, ...out.get("Keerti").undated];
  assert.equal(all.some((e) => /still open/.test(e.heading)), false);
});

test("out-of-window and UNDATED are different outcomes, and neither is silently dropped", () => {
  const out = resolvedElsewhereByOwner(
    { issueFiles: [{ file: RESOLVED_FILE }] }, K, NOW, () => RESOLVED_TEXT,
  );
  const got = out.get("Keerti");
  // 2020 is out of window: absent from `dated` and NOT smuggled into `undated`.
  assert.equal(got.dated.some((e) => e.resolvedISO === "2020-01-01"), false);
  // The undated one is reported in its own bucket. "I could not apply the window"
  // is a third fact, not a pass and not an omission (rule:discernment-checks §2).
  assert.equal(got.undated.length, 1);
  assert.match(got.undated[0].heading, /undated closure/);
});

test("the window is injectable, so the test does not drift as the wall clock moves", () => {
  const farFuture = new Date("2030-01-01T00:00:00Z");
  const out = resolvedElsewhereByOwner(
    { issueFiles: [{ file: RESOLVED_FILE }] }, K, farFuture, () => RESOLVED_TEXT,
  );
  assert.equal(out.get("Keerti").dated.length, 0, "nothing is within 30 days of 2030");
  assert.equal(typeof RESOLVED_WINDOW_DAYS, "number");
});
