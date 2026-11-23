/**
 * lib/research/quotes.mjs — the one place a quote is normalised, so a researcher checking a quote and the gate
 * checking it read the same bytes (#324, design §S3). Pure: no I/O, no clock.
 *
 * WHY ONE NORMALISER. A model that quotes from a page it only saw through a summariser writes a paraphrase that
 * looks like a quote. The check is "does this exact run of words occur in the fetched text", which only means
 * something if both sides are reduced the same way first. Two normalisers would be two truths about one page.
 *
 * Offsets returned by findQuote are into the NORMALISED text (normalizeText(text)), never the raw one: stripping
 * markdown and collapsing whitespace changes lengths, and a pretend raw offset would be wrong by an amount nobody
 * could recover. Callers that need the raw position re-derive it; the gate only needs found / not found.
 */

/** A quote is 6 to 15 words. Shorter matches by luck; longer is a block of someone else's text, not a quote. */
export const MIN_QUOTE_WORDS = 6;
export const MAX_QUOTE_WORDS = 15;

const CURLY_SINGLE = /[‘’‚‛′ʼ]/g;
const CURLY_DOUBLE = /[“”„‟″]/g;
// Soft hyphen and the zero-width family: invisible in a browser, present in the bytes.
const INVISIBLE = /[­​‌‍⁠﻿]/g;

/**
 * Reduce text to the form a quote is compared in. Order matters: NFKC first (it turns nbsp into a plain space and
 * ligatures into letters), then quotes, then markdown, then whitespace last so removals do not leave double spaces.
 */
export function normalizeText(input) {
  let s = String(input ?? "").normalize("NFKC");
  s = s.replace(INVISIBLE, "").replace(CURLY_SINGLE, "'").replace(CURLY_DOUBLE, '"').replace(/ /g, " ");
  // Images then links: `![alt](url)` and `[text](url "title")` keep only the visible text. Reference-style
  // links `[text][ref]` keep the text too.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  // Bare autolinks `<https://x>` carry no words.
  s = s.replace(/<https?:\/\/[^>\s]+>/g, "");
  // Emphasis and code marks. `**x**` and `__x__` first, then single `*` and backticks. A single `_` is stripped
  // only at a word edge so snake_case identifiers inside a quote survive.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  s = s.replace(/\*+/g, "").replace(/`+/g, "");
  s = s.replace(/(^|[\s(])_+(?=\S)/g, "$1").replace(/(?<=\S)_+(?=[\s).,;:!?]|$)/g, "");
  // Heading and quote-block markers at line start, then every run of whitespace to one space.
  s = s.replace(/^[ \t]*(?:#{1,6}|>)[ \t]+/gm, "");
  return s.replace(/\s+/g, " ").trim();
}

/** Word count of a quote, after normalisation. */
export function wordCount(quote) {
  const n = normalizeText(quote);
  return n === "" ? 0 : n.split(" ").length;
}

/**
 * Is this quote a size the gate accepts?
 * @returns {{ok: true, words: number}|{ok: false, words: number, reason: string}}
 */
export function checkQuoteLength(quote) {
  const words = wordCount(quote);
  if (words < MIN_QUOTE_WORDS) {
    return { ok: false, words, reason: `quote is ${words} word${words === 1 ? "" : "s"}; ${MIN_QUOTE_WORDS}-${MAX_QUOTE_WORDS} are required, because a shorter match is luck` };
  }
  if (words > MAX_QUOTE_WORDS) {
    return { ok: false, words, reason: `quote is ${words} words; ${MIN_QUOTE_WORDS}-${MAX_QUOTE_WORDS} are required, so trim it to the load-bearing run` };
  }
  return { ok: true, words };
}

/**
 * Does `quote` occur in `text`, once both are normalised?
 *
 * A refused quote is `{found: false, offset: -1, refused: <reason>}`, never `found: true` and never a throw: a
 * 2-word "quote" matching somewhere is the false pass the length rule exists to stop.
 *
 * @returns {{found: boolean, offset: number, refused?: string}} offset is into normalizeText(text), -1 when not found
 */
export function findQuote(text, quote) {
  const len = checkQuoteLength(quote);
  if (!len.ok) return { found: false, offset: -1, refused: len.reason };
  const offset = normalizeText(text).indexOf(normalizeText(quote));
  return { found: offset >= 0, offset };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", shy: "­", copy: "©" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK_TAGS = "address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul";

/**
 * The fixed HTML-to-text step. Deliberately small and deterministic: drop non-content elements, turn block
 * boundaries into newlines, strip the remaining tags, decode entities. No readability heuristics, because a
 * heuristic that decides what the "main content" is can drop the sentence a quote came from.
 */
export function htmlToText(html) {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
