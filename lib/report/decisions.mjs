/**
 * DECISIONS.md parser for the cross-repo decision-driven trigger (Slice 2, §4b).
 *
 * Parses append-only DECISIONS.md into entries keyed by an edit/move-stable
 * identity: `<date>:<sha8(normalized Affects line)>` (title excluded — G4).
 * Handles BOTH heading forms (colon AND em-dash — G1) and the `(final)` variant.
 */
import { createHash } from "node:crypto";

// G1: date first, then an OPTIONAL separator (colon, em-dash, hyphen) + title.
// Also tolerates "## 2026-05-05 (final): …" — the date is captured by regex, not position.
const HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\b.*$/;

function sha8(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/**
 * Normalize one Affects: token: strip a trailing parenthetical or " —"/" -" note,
 * trim, lowercase. Returns "" for placeholder tokens (containing "<") so they're skipped.
 */
export function normalizeAffectsToken(tok) {
  let t = String(tok);
  if (t.includes("<")) return ""; // template placeholder like <project list>
  const cut = t.search(/\s*[(]|\s+[—-]\s/);
  if (cut >= 0) t = t.slice(0, cut);
  t = t.trim();
  // Strip markdown emphasis / code ticks wrapping a single token. N12 fixed the
  // label (`**Affects:**` vs `Affects:`); this is the same miss one level down --
  // `**propagate**` and `propagate` must normalize to the same target, or an
  // emphasized entry silently matches nothing and the gate passes it anyway.
  t = t.replace(/^[*_`]+/, "").replace(/[*_`]+$/, "");
  return t.trim().toLowerCase();
}

/**
 * Parse DECISIONS.md text into entries.
 * @param {string} text
 * @returns {Array<{date, title, affectsRaw, tokens: string[], key: string}>}
 *   key is `<date>:<sha8(affects)>` with a `#N` suffix on within-file collisions.
 */
export function parseDecisions(text) {
  const lines = String(text).split("\n");
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      // Title = whatever follows the date + separator, if any.
      const afterDate = line.slice(line.indexOf(m[1]) + m[1].length);
      const title = afterDate.replace(/^\s*[:—-]?\s*/, "").trim();
      cur = { date: m[1], title, body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) entries.push(cur);

  const seen = new Map(); // baseKey -> count, for the collision guard
  const out = [];
  for (const e of entries) {
    const body = e.body.join("\n");
    // Accept both bare ("Affects: x") and markdown-bold ("**Affects:** x") forms —
    // docs/DECISIONS.md's own template (line 5-6) prescribes the bold form, and every
    // live entry uses it; the bare form is kept for back-compat with old/synthetic text.
    // The capture group excludes a trailing "**" so bold values don't carry it into affectsRaw.
    const am = /^\*{0,2}Affects:\*{0,2}\s*(.+?)\s*$/m.exec(body);
    let affectsRaw = am ? am[1].trim() : "";
    if (affectsRaw.endsWith("**")) affectsRaw = affectsRaw.slice(0, -2).trim();
    const tokens = affectsRaw
      ? affectsRaw.split(",").map(normalizeAffectsToken).filter(Boolean)
      : [];
    const baseKey = `${e.date}:${sha8(affectsRaw)}`;
    const n = seen.get(baseKey) ?? 0;
    seen.set(baseKey, n + 1);
    const key = n === 0 ? baseKey : `${baseKey}#${n}`; // collision guard — 2nd+ still fires
    out.push({ date: e.date, title: e.title, affectsRaw, tokens, key, collision: n > 0 });
  }
  return out;
}

/**
 * Report entries whose Affects: field yielded zero usable tokens — the exact
 * silent-no-op class N12 describes (regex mismatch, empty field, all-placeholder
 * tokens, etc). A non-empty `entries` array with every entry showing up here means
 * the parser is reading nothing from a file that has content; that is always a bug,
 * never a legitimate state, and should fail a `doctor`-style check.
 *
 * Not wired into cli.mjs's doctor command here — that file is owned by another
 * concurrent edit. Callers there can do:
 *   const zero = zeroTokenEntries(parseDecisions(text));
 *   if (entries.length > 0 && zero.length === entries.length) { ...fail... }
 *
 * @param {Array<{date, title, affectsRaw, tokens: string[]}>} entries - output of parseDecisions
 * @returns {Array<{date, title, affectsRaw}>} the subset with tokens.length === 0
 */
export function zeroTokenEntries(entries) {
  return entries
    .filter((e) => !e.tokens || e.tokens.length === 0)
    .map((e) => ({ date: e.date, title: e.title, affectsRaw: e.affectsRaw }));
}

/**
 * N12: classify a DECISIONS.md's `Affects:` attribution health. `zeroTokenEntries`
 * above already isolates the exact N12 failure mode (regex mismatch, empty field,
 * all-placeholder tokens); this composes it into the shapes `doctor` needs —
 * `entries`, the zero-token subset, and `allZero`, which in a NON-EMPTY file is
 * always a parser bug rather than data (the mechanism that records why a choice
 * was made, unable to read its own attribution field). That bug shipped silently
 * for weeks — all 8 live entries at 0 tokens — before being caught by hand.
 *
 * Moved here from cli.mjs 2026-08-25: it is four lines composing the two
 * functions directly above it, and leaving it in cli.mjs meant an extracted
 * doctor module would have to import from cli.mjs, which imports it back.
 *
 * Pure (text in, verdict out) so it is unit-testable against synthetic
 * fixtures without shelling out to `doctor`. cli.mjs re-exports it so the two
 * existing test files keep their import path.
 *
 * @param {string} text - raw DECISIONS.md content
 * @returns {{entries: Array, zero: Array, allZero: boolean}}
 */
export function decisionsAttributionReport(text) {
  const entries = parseDecisions(text);
  const zero = zeroTokenEntries(entries);
  return { entries, zero, allZero: entries.length > 0 && zero.length === entries.length };
}
