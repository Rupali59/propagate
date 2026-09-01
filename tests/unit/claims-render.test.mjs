/**
 * Marker rendering: putting a verdict beside its block without corrupting the
 * document or the identity the verdict is pinned to.
 *
 * THE INVARIANT THIS FILE EXISTS FOR, found before any test was written. A marker
 * is written on the line directly beneath its block, with no blank line between —
 * that adjacency is what makes it read as belonging to that block. But `splitBlocks`
 * separates on blank lines, so without special handling the marker is ABSORBED into
 * the block, changes its text, changes its sha, and orphans the very verdict it
 * renders. Rendering would silently un-judge the whole file, and each re-render
 * would append another marker.
 *
 * Fixed in `blocks.mjs` rather than here, so the invariant cannot be violated by a
 * future caller: propagate's own annotations are counted (line numbers stay true to
 * the real file) but never form part of a block. The two tests that matter are
 * therefore "identity survives rendering" and "rendering twice changes nothing".
 *
 * The other half is that this writes into files a PERSON wrote. `VIPIN.md` is 420
 * lines of someone's writing, mode 0600, about a real human. So: dry-run default,
 * `--apply` required, one explicit path, no walking — and a hand-edited marker is
 * REFUSED rather than overwritten, because a marker disagreeing with the store means
 * an opinion was recorded in the output instead of in the judgment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { splitBlocks } from "../../lib/claims/blocks.mjs";
import { renderMarkers, markerFor, MARKER_RE } from "../../lib/claims/render.mjs";

const TS = "2026-09-01T00:00:00.000Z";
const DOC = "First claim here.\n\nSecond claim here.\n";

function verdictsFor(doc, kinds) {
  const blocks = splitBlocks(doc).filter((b) => b.judgeable);
  return new Map(
    blocks.map((b, i) => [b.sha, { block_sha: b.sha, kind: kinds[i] ?? "fact", ts: TS, by_kind: "agent" }]),
  );
}

test("a verdict renders as a marker directly beneath its block", () => {
  const r = renderMarkers(DOC, verdictsFor(DOC, ["fact", "impression"]));
  assert.equal(r.added, 2);
  assert.equal(r.handEdited.length, 0);
  const lines = r.text.split("\n");
  assert.equal(lines[0], "First claim here.");
  assert.match(lines[1], MARKER_RE, "the marker must sit on the line after its block");
});

test("BLOCK IDENTITY SURVIVES RENDERING — the invariant the whole design rests on", () => {
  const before = splitBlocks(DOC).filter((b) => b.judgeable).map((b) => b.sha);
  const rendered = renderMarkers(DOC, verdictsFor(DOC, ["fact", "impression"])).text;
  const after = splitBlocks(rendered).filter((b) => b.judgeable).map((b) => b.sha);
  assert.deepEqual(after, before, "a marker must not change the hash of the block it describes");
});

test("rendering twice changes nothing — no marker pile-up", () => {
  const v = verdictsFor(DOC, ["fact", "impression"]);
  const once = renderMarkers(DOC, v);
  const twice = renderMarkers(once.text, v);
  assert.equal(twice.added, 0);
  assert.equal(twice.text, once.text, "idempotence: re-rendering an already-rendered file is a no-op");
});

test("prose is never touched — only marker lines may be added, changed or removed", () => {
  const rendered = renderMarkers(DOC, verdictsFor(DOC, ["fact", "impression"])).text;
  const proseOnly = rendered.split("\n").filter((l) => !MARKER_RE.test(l)).join("\n");
  assert.equal(proseOnly, DOC, "authored bytes must survive verbatim, unreflowed and unreindented");
});

test("a verdict that disappears takes its marker with it", () => {
  const v = verdictsFor(DOC, ["fact", "impression"]);
  const rendered = renderMarkers(DOC, v).text;
  // Store now knows nothing: e.g. the verdicts were dropped as orphaned.
  const r = renderMarkers(rendered, new Map());
  assert.equal(r.removed, 2, "a marker with no verdict behind it is the file asserting what the store does not");
  assert.equal(r.text.split("\n").filter((l) => MARKER_RE.test(l)).length, 0);
});

test("a HAND-EDITED marker is reported, never silently corrected", () => {
  const v = verdictsFor(DOC, ["fact", "impression"]);
  const rendered = renderMarkers(DOC, v).text;
  // Someone disagreed and edited the OUTPUT rather than the judgment.
  const tampered = rendered.replace(/fact · /, "impression · ");
  const r = renderMarkers(tampered, v);
  assert.equal(r.handEdited.length, 1, "the disagreement must surface");
  assert.equal(typeof r.handEdited[0].line, "number");
  assert.match(r.handEdited[0].found, /impression/);
  assert.match(r.handEdited[0].expected, /fact/);
});

test("the marker carries standing and finding when present, and omits them when not", () => {
  const base = { block_sha: "c".repeat(64), kind: "fact", ts: TS };
  assert.doesNotMatch(markerFor(base), /current/, "the default standing is not noise worth printing");
  assert.match(markerFor({ ...base, standing: "wrong" }), /wrong/);
  assert.match(markerFor({ ...base, against: "d".repeat(64), finding: "contradicts" }), /contradicts/);
  assert.match(markerFor({ ...base, by_kind: "agent" }), /by:agent/, "who judged is part of the record");
});

test("markers are HTML comments — invisible rendered, plain in source where agents read", () => {
  const m = markerFor({ block_sha: "e".repeat(64), kind: "policy", ts: TS });
  assert.ok(m.startsWith("<!--") && m.endsWith("-->"));
  assert.match(m, MARKER_RE);
});

test("an unjudged block gets no marker at all", () => {
  const r = renderMarkers(DOC, new Map());
  assert.equal(r.added, 0);
  assert.equal(r.text, DOC, "nothing judged means nothing written");
});

test("nothing-judged is NOT the same state as markers-are-current", async () => {
  const { renderStatus } = await import("../../lib/claims/render.mjs");
  // With no store at all, a document full of judgeable blocks must report
  // "nothing judged", never "current". Conflating them is how a path-spelling bug
  // presented as success for an hour.
  const s = await renderStatus("/fake/none.md", { readFile: () => DOC });
  assert.equal(s.nothingJudged, true);
  assert.equal(s.judgeable, 2);
  assert.equal(s.verdicts, 0);
  assert.equal(s.unchanged, true, "and it is ALSO unchanged — which is exactly why the two must be reported separately");
});
