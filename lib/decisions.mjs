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
    const am = /^Affects:\s*(.+)$/m.exec(body);
    const affectsRaw = am ? am[1].trim() : "";
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
