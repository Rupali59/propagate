/**
 * lib/claims/blocks.mjs — split a markdown document into judgeable CLAIMS.
 *
 * READ-ONLY and PURE: takes text, returns blocks. No fs, no network, no model.
 * The LLM/deterministic split in the Phase 2 plan puts splitting and hashing
 * firmly on the mechanical side; deciding what a block MEANS is `judge`'s job
 * and must never leak in here.
 *
 * WHY A BLOCK, AND NOT A SECTION OR A MARKED SPAN. The corpus this exists for
 * already exists, unmarked: a workspace constitution doc is 420
 * lines mixing ~15% hard operational fact with ~50% impression, and nothing in
 * it distinguishes them. A scheme needing hand-markup means that file is never
 * judged, because nobody marks up 42 KB. A scheme at section granularity gives
 * one verdict to a section holding one checkable price and three impressions,
 * which is wrong for all four. A paragraph or list item is the smallest unit
 * that carries one claim and can be derived without human help.
 *
 * IDENTITY IS THE HASH OF NORMALISED TEXT, and normalisation is doing real work.
 * Hashing raw bytes would re-open every block in a file whenever someone
 * reflowed a paragraph or changed a line width — a verdict lost to a cosmetic
 * edit is a verdict people stop bothering to record. So whitespace runs collapse
 * to a single space and the result is trimmed: rewrapping is invisible, and any
 * change to the WORDS moves the hash. Editing a block correctly re-opens exactly
 * that block and leaves every other verdict standing.
 *
 * WHAT IS DELIBERATELY NOT A CLAIM. Fenced code, tables, headings, HTML comments
 * and horizontal rules are structure, not assertions, and judging them would
 * bury the blocks that matter under noise nobody can act on. They are SKIPPED
 * with a recorded `kind`, never silently dropped — `splitBlocks` returns them
 * too, flagged, so a caller can say "47 blocks, 12 skipped as structure" rather
 * than reporting a smaller number with no explanation (`rule:discernment-checks`
 * §2: absence must be attributable).
 */
import { createHash } from "node:crypto";

/** Block kinds. `prose` and `list-item` are judgeable; the rest are structure. */
export const BLOCK_KINDS = Object.freeze(["prose", "list-item", "code", "table", "heading", "comment", "rule"]);

/** The kinds a verdict can attach to. Structure is not a claim. */
export const JUDGEABLE = Object.freeze(["prose", "list-item"]);

/**
 * Normalise for hashing: collapse all whitespace runs to one space, trim.
 *
 * This is the whole reason a reflow does not invalidate a verdict. It is
 * deliberately NOT lowercasing or stripping punctuation — those change meaning,
 * and two blocks differing only in case are two different claims.
 */
export function normaliseBlock(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** sha256 of the normalised text. Full 64 hex; callers shorten for display. */
export function blockSha(text) {
  return createHash("sha256").update(normaliseBlock(text), "utf8").digest("hex");
}

/**
 * propagate's OWN generated annotations, which are never part of a block.
 *
 * THIS IS A CORRECTNESS INVARIANT, NOT TIDINESS. A claim marker is written on the
 * line directly beneath its block, with no blank line between — that is what makes
 * it read as belonging to that block. Without this, the marker is absorbed into the
 * block, changes its text, changes its sha, and therefore ORPHANS THE VERY VERDICT
 * IT RENDERS. Rendering would silently un-judge the whole file, and re-rendering
 * would append a second marker each time.
 *
 * Handled here rather than in `render.mjs` so the invariant cannot be violated by a
 * future caller: block identity is computed on the AUTHORED text, always. The lines
 * are still COUNTED, so `startLine`/`endLine` keep pointing at the real file — a
 * renderer inserting by line number must not be handed positions from a phantom
 * document.
 */
const GENERATED_MARKER_RE = /^\s*<!--\s*propagate:(claim|rollup)\b/;

function classify(lines) {
  const first = (lines[0] ?? "").trim();
  if (/^```/.test(first)) return "code";
  if (/^#{1,6}\s/.test(first)) return "heading";
  if (/^<!--/.test(first)) return "comment";
  if (/^(\*{3,}|-{3,}|_{3,})$/.test(first)) return "rule";
  if (/^\|/.test(first)) return "table";
  if (/^([-*+]|\d+\.)\s/.test(first)) return "list-item";
  return "prose";
}

/**
 * Split `text` into blocks.
 *
 * Blank lines separate blocks; inside a list, EACH item is its own block, so a
 * bullet list of five refusals yields five judgeable claims rather than one.
 * Fenced code is held together regardless of blank lines inside it — a blank
 * line in a code fence is not a block boundary, and treating it as one would
 * emit fragments that are not claims and cannot be judged.
 *
 * @param {string} text
 * @returns {Array<{index:number, kind:string, judgeable:boolean, text:string,
 *                  sha:string, startLine:number, endLine:number}>}
 */
export function splitBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let buf = [];
  let start = 0;
  let inFence = false;

  const flush = (endLine) => {
    if (buf.length === 0) return;
    // A block of only whitespace is not a claim and not structure — it is
    // nothing, and emitting it would inflate every count downstream.
    if (buf.join("").trim() === "") { buf = []; return; }
    const kind = classify(buf);
    const blockText = buf.join("\n");
    out.push({
      index: out.length,
      kind,
      judgeable: JUDGEABLE.includes(kind),
      text: blockText,
      sha: blockSha(blockText),
      startLine: start + 1, // 1-indexed, matching every other reader in this repo
      endLine,
    });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceEdge = /^\s*```/.test(line);

    if (fenceEdge) {
      if (!inFence) { flush(i); start = i; inFence = true; buf.push(line); continue; }
      buf.push(line);
      inFence = false;
      flush(i + 1);
      start = i + 1;
      continue;
    }
    if (inFence) { buf.push(line); continue; }

    // Our own annotation: counted (so line numbers stay true to the real file) but
    // never part of a block. See GENERATED_MARKER_RE — without this, rendering a
    // marker changes the hash of the block it describes.
    if (GENERATED_MARKER_RE.test(line)) continue;

    if (line.trim() === "") { flush(i); start = i + 1; continue; }

    // A new list item starts a new block even without a blank line between —
    // otherwise a five-bullet list is one claim and none of the five can be
    // judged separately, which is the section-granularity failure one level down.
    if (/^\s*([-*+]|\d+\.)\s/.test(line) && buf.length > 0 && classify(buf) === "list-item") {
      flush(i);
      start = i;
    }
    if (buf.length === 0) start = i;
    buf.push(line);
  }
  flush(lines.length);
  return out;
}

/** Convenience: only the blocks a verdict can attach to. */
export function judgeableBlocks(text) {
  return splitBlocks(text).filter((b) => b.judgeable);
}
