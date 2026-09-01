/**
 * lib/claims/render.mjs — put each block's verdict beside it, in the file, so a
 * reader sees the epistemic status without running anything.
 *
 * WHY MARKERS AT ALL, WHEN THE STORE ALREADY HAS THE ANSWER. Because the store is
 * a sidecar nobody opens, and this whole layer exists because agents read FILES.
 * A verdict only reachable via `claims judge --json` has exactly the defect
 * `ECOSYSTEM.md` was built to fix, one level down. So: store is canonical, marker
 * is GENERATED from it, and the two cannot disagree because one is derived from
 * the other. That was decision D7.
 *
 * THIS FILE IS DIFFERENT FROM `rollup` IN THE WAY THAT MATTERS. `ECOSYSTEM.md` is
 * generated end to end, so a hand edit anywhere in it is a mistake and the command
 * refuses wholesale. Here the document is AUTHORED — `VIPIN.md` is 420 lines of
 * someone's writing — and only the marker lines are ours. So the contract is
 * narrower and stricter: **we touch marker lines and nothing else.** Prose is
 * never reflowed, never reindented, never normalised on write. The only bytes
 * this module may add, change or remove are lines matching MARKER_RE.
 *
 * DRY-RUN IS THE DEFAULT AND `--apply` IS REQUIRED, deliberately inverting
 * `rollup`'s posture. `rollup` writes a file it owns; this writes into files a
 * person wrote, one of which is mode 0600 and about a real human. The repo
 * already sets this precedent for anything that edits what it does not own
 * (`verify`, `bootstrap`), and `rule:safety-flag-needs-a-test` requires the
 * unsafe path be provably unreachable without the flag — asserted by snapshotting
 * the file, not by reading the word "would" out of stdout.
 *
 * A HAND-EDITED MARKER IS REFUSED, NOT OVERWRITTEN. If a marker disagrees with the
 * store, someone edited the rendered output instead of the judgment. Silently
 * regenerating would discard a real opinion and teach people the file lies; the
 * refusal names the block and points at `claims judge`, which is where that
 * opinion belongs. Same posture as `migrate`'s "never clobber a hand-written
 * sidecar" and `rollup`'s exit 3.
 */
import { splitBlocks } from "./blocks.mjs";
import { readClaims, latestByBlock } from "./store.mjs";

/**
 * A generated marker. Deliberately an HTML comment: invisible in rendered
 * markdown, so a document does not become unreadable to a human just because it
 * has been judged, while staying plainly visible to anyone reading the source —
 * which is where agents read.
 */
export const MARKER_RE = /^<!--\s*propagate:claim\s+([0-9a-f]{12})\s+(.+?)\s*-->$/;

const MARKER_PREFIX = "<!-- propagate:claim ";

/** Render one verdict as its marker line. The ONLY place this string is built. */
export function markerFor(verdict) {
  const parts = [verdict.kind];
  if (verdict.standing && verdict.standing !== "current") parts.push(verdict.standing);
  if (verdict.finding) parts.push(verdict.finding);
  parts.push(String(verdict.ts ?? "").slice(0, 10));
  if (verdict.by_kind) parts.push(`by:${verdict.by_kind}`);
  return `${MARKER_PREFIX}${verdict.block_sha.slice(0, 12)} ${parts.join(" · ")} -->`;
}

/**
 * Compute the rendered text without writing it.
 *
 * @returns {{text: string, added: number, updated: number, removed: number,
 *            handEdited: Array<{sha: string, line: number, found: string, expected: string}>}}
 *   `handEdited` non-empty means the caller must REFUSE. `text` is still returned
 *   so a preview can show what would have happened, but it must not be written.
 */
export function renderMarkers(sourceText, verdictsByBlock) {
  const lines = String(sourceText ?? "").split("\n");
  const blocks = splitBlocks(sourceText);

  // Two views of the same set, built once. `wantAfter` drives INSERTION (a marker
  // goes immediately after its block's last line); `byShort` drives RECONCILING an
  // existing marker, which is found by the 12-hex prefix it carries rather than by
  // position — a marker that drifted a line or two is still that block's marker.
  const wantAfter = new Map(); // endLine -> {verdict, sha}
  const byShort = new Map(); //   short sha -> {verdict, sha}
  for (const b of blocks) {
    if (!b.judgeable) continue;
    const v = verdictsByBlock.get(b.sha);
    if (!v) continue;
    wantAfter.set(b.endLine, { verdict: v, sha: b.sha });
    byShort.set(b.sha.slice(0, 12), { verdict: v, sha: b.sha });
  }

  const out = [];
  const handEdited = [];
  const emitted = new Set(); // shas whose marker is already in `out`
  let added = 0, updated = 0, removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(MARKER_RE);

    if (m) {
      // An existing marker. Whether it stays, changes or goes is decided entirely
      // by the store — never by what it currently says.
      const owner = byShort.get(m[1]);
      if (!owner || emitted.has(owner.sha)) {
        // Its block is gone, is no longer judged, or this is a duplicate. Drop it:
        // a marker with no verdict behind it is the file asserting something the
        // store does not.
        removed++;
        continue;
      }
      const expected = markerFor(owner.verdict);
      if (line.trim() !== expected) {
        // Disagrees with the store. This module cannot tell a stale render from a
        // hand edit, so it REPORTS rather than guesses and the command refuses.
        // Guessing "probably stale" is how a real opinion gets silently deleted.
        handEdited.push({ sha: owner.sha, line: i + 1, found: line.trim(), expected });
        updated++;
      }
      out.push(expected);
      emitted.add(owner.sha);
      continue;
    }

    out.push(line);
    const want = wantAfter.get(i + 1);
    if (want && !emitted.has(want.sha)) {
      out.push(markerFor(want.verdict));
      emitted.add(want.sha);
      added++;
    }
  }

  return { text: out.join("\n"), added, updated, removed, handEdited };
}

/**
 * Full status for one file: what the render would do, against the live store.
 *
 * `readFile` is injected so this is testable without touching disk, and so a
 * caller that already holds the text does not read it twice.
 */
export async function renderStatus(file, opts = {}) {
  const read = opts.readFile;
  let text;
  try {
    text = read ? read(file) : (await import("../report/backlog.mjs")).readTextSafe(file).text;
  } catch (err) {
    return { file, error: `unreadable: ${err.message}` };
  }
  if (text == null) return { file, error: "unreadable: no content returned" };

  const { claims, storeExists } = await readClaims({ file });
  const latest = latestByBlock(claims);
  const result = renderMarkers(text, latest);

  // "Nothing to write" has TWO causes and they are not the same fact:
  //   the markers are up to date, or nothing has been judged at all.
  // Reporting both as "current" is how a path-spelling bug presented as success
  // — a verdict stored under /tmp/x and looked up under /private/tmp/x made every
  // verdict invisible, and render called that "markers already match the store".
  // `rule:discernment-checks` §2: absence must be attributable.
  const judgeable = splitBlocks(text).filter((b) => b.judgeable).length;
  const verdicts = [...latest.keys()].length;

  return {
    file,
    error: null,
    storeExists,
    judgeable,
    verdicts,
    nothingJudged: verdicts === 0 && judgeable > 0,
    unchanged: result.text === text,
    ...result,
  };
}
