/**
 * render.mjs — the glance line (propagate#295, design §3). PURE: no imports, no filesystem.
 *
 *   <icon> <subject>: <what> · <fix>          at most 80 characters
 *
 * The icon is a glyph AND the group word, never colour alone. Subjects are names, never paths. Free text (a doctor
 * label, a job label) is clipped from the `what`, never from the fix, so the action survives the cut.
 * Order: needs-you (oldest first), then broken (widest first, then oldest), then ONE working line naming the signals.
 * Caps: 5 item lines, then `+N more`. All clear is one line, never silence.
 */

export const MAX_LINE = 80;
export const TERMINAL_CAP = 5;

export const ICON = Object.freeze({ needs_you: "! Needs you", broken: "x Broken", unknown: "? Unknown", working: "ok Working" });

export const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/** Local HH:MM. */
export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Which icon an item takes: an unknown flag overrides its group's icon (it sits in Broken but says so). */
export const iconOf = (it) => (it.flag === "unknown" ? ICON.unknown : ICON[it.verdict]);

/** One line, clipping `what` (never the fix) to fit MAX_LINE. */
export function formatLine(icon, subject, what, fixText) {
  const head = `${icon} ${clip(subject, 24)}: `;
  const tail = ` · ${fixText}`;
  const room = MAX_LINE - head.length - tail.length;
  return clip(`${head}${clip(what, Math.max(room, 1))}${tail}`, MAX_LINE);
}

const sinceMs = (it) => Date.parse(it.since ?? "") || 0;

/** Needs-you oldest first; broken widest first then oldest. Working is not ordered here (it collapses). */
export function ordered(items) {
  const needs = items.filter((i) => i.verdict === "needs_you").sort((a, b) => sinceMs(a) - sinceMs(b));
  const broken = items.filter((i) => i.verdict === "broken").sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || sinceMs(a) - sinceMs(b));
  return [...needs, ...broken];
}

/** The one working line: the signals that are working, then the learning ones, and when. */
export function workingLine(items, generatedAtMs) {
  const working = items.filter((i) => i.verdict === "working");
  if (!working.length) return null;
  const plain = [...new Set(working.filter((i) => i.flag !== "learning").map((i) => i.signal))];
  const learning = [...new Set(working.filter((i) => i.flag === "learning").map((i) => i.signal))];
  const what = [plain.join(", "), learning.length ? `learning: ${learning.join(", ")}` : ""].filter(Boolean).join("; ");
  // `ok Working: <signals> · checked HH:MM` (design §3 example): the signals ARE the subject here, so no second label.
  const tail = ` · checked ${hhmm(generatedAtMs)}`;
  const head = `${ICON.working}: `;
  return `${head}${clip(what, MAX_LINE - head.length - tail.length)}${tail}`;
}

/**
 * The terminal view of a glance.
 * @param {object} glance a glance.json object
 * @param {{cap?: number}} [opts]
 * @returns {string[]}
 */
export function renderLines(glance, { cap = TERMINAL_CAP } = {}) {
  if (glance.verdict === "blind") return ["glance: nothing to read yet"];
  const at = Date.parse(glance.generatedAt);
  const problems = ordered(glance.items);
  if (!problems.length) return [`All clear · ${glance.signals_checked} signals checked · ${hhmm(at)}`];
  const out = problems.slice(0, cap).map((i) => i.line);
  if (problems.length > cap) out.push(`+${problems.length - cap} more: propagate glance --json`);
  const w = workingLine(glance.items, at);
  if (w) out.push(w);
  return out;
}
