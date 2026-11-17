/**
 * render.mjs — the glance in the terminal (propagate#295, design §3; grouping and badges ruled 2026-11-16).
 *
 * ONE LINE PER SOURCE, never one per item (Rupali, 2026-11-16): six doctor fails must not push three failing jobs off
 * the screen. Each source line is
 *
 *   <badge> <source>: <count> <verdict> (<top subjects, short>) · <fix>        at most 80 visible characters
 *
 *   [BROKEN]    doctor: 6 checks failing (path-scoped, docs, gotchas…) · propagate doctor --full
 *   [BROKEN]    jobs: 3 jobs failing (last exit code 1) · propagate doctor --full
 *
 * Order: needs-you sources first, then broken (unknown sits with broken), then the working sources collapsed into one
 * OK line (and one LEARNING line). Within a verdict, user-impacting sources (SOURCE_RANK: jobs, the needs-you queues,
 * hooks, guard) come before doctor's internal checks. The 5-line cap counts SOURCES, then `+N more`. The per-item
 * detail stays in `glance --json` and the items array; only this rendering groups.
 *
 * NO MID-WORD CUT. Subjects are added while they fit and the rest becomes `…`; free text is cut at a word boundary.
 *
 * BADGES. A fixed-width, bold, coloured badge through node:util `styleText` (built in since the Node 22.13 floor, so
 * no dependency; rung 1 of rule:docs-libraries-repos-then-custom). Colour only when the caller says so (shouldColor:
 * a TTY, no NO_COLOR, no --no-color); otherwise the plain bracketed word, `[BROKEN]`, padded to the same width, so the
 * 80-character rule holds either way. The session line (hooks/session-guide.mjs) is read by Claude, never a terminal,
 * and stays plain.
 */
import { styleText } from "node:util";

export const MAX_LINE = 80;
export const TERMINAL_CAP = 5;
export const BADGE_WIDTH = 11; // "[NEEDS YOU]" and " NEEDS YOU " are both 11

/** User-impacting sources first, doctor's internal checks last. hooks/session-guide.mjs carries a copy (parity-tested). */
export const SOURCE_RANK = Object.freeze(["jobs", "work", "broadcast", "hooks", "guard", "monitor", "edges", "metrics", "doctor"]);

/** Kept for the per-item `line` in glance.json (the contract, unchanged): a glyph and the group word. */
export const ICON = Object.freeze({ needs_you: "! Needs you", broken: "x Broken", unknown: "? Unknown", working: "ok Working" });

const BADGE = Object.freeze({
  needs_you: { word: "NEEDS YOU", style: ["black", "bgYellow", "bold"] },
  broken: { word: "BROKEN", style: ["white", "bgRed", "bold"] },
  unknown: { word: "UNKNOWN", style: ["black", "bgGray", "bold"] },
  learning: { word: "LEARNING", style: ["black", "bgCyan", "bold"] },
  ok: { word: "OK", style: ["black", "bgGreen", "bold"] },
  acked: { word: "ACKED", style: ["black", "bgWhite", "bold"] },
});

/** Hard clip, for ids and subjects that are one token. */
export const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/** Clip at a word boundary: never cuts a word in half. */
export function clipWords(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  if (n <= 1) return "…";
  let cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  if (sp > 0) cut = cut.slice(0, sp);
  else return "…";
  return `${cut.replace(/[\s,;:(·-]+$/, "")}…`;
}

/** Local HH:MM. */
export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Which icon an item's own `line` takes: an unknown flag overrides its group's icon. */
export const iconOf = (it) => (it.flag === "unknown" ? ICON.unknown : ICON[it.verdict]);

/** One item's `line` for glance.json: `<icon> <subject>: <what> · <fix>`, `what` clipped at a word (never the fix). */
export function formatLine(icon, subject, what, fixText) {
  const head = `${icon} ${clip(subject, 24)}: `;
  const tail = ` · ${fixText}`;
  return clip(`${head}${clipWords(what, Math.max(MAX_LINE - head.length - tail.length, 1))}${tail}`, MAX_LINE);
}

/**
 * Colour on? Only for a TTY, and never with NO_COLOR (any non-empty value) or --no-color. FORCE_COLOR (non-empty,
 * not "0") turns it on for a non-TTY, but NO_COLOR still wins.
 */
export function shouldColor({ stream = process.stdout, env = process.env, argv = [] } = {}) {
  if (argv.includes("--no-color")) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream?.isTTY);
}

/** The caller decided colour already, so styleText must not re-check the stream. */
const paint = (style, text) => styleText(style, text, { validateStream: false });

export function badge(kind, color) {
  const b = BADGE[kind];
  return color ? paint(b.style, ` ${b.word}`.padEnd(BADGE_WIDTH)) : `[${b.word}]`.padEnd(BADGE_WIDTH);
}

const sinceMs = (it) => Date.parse(it.since ?? "") || 0;
const rankOf = (signal) => {
  const i = SOURCE_RANK.indexOf(signal);
  return i === -1 ? SOURCE_RANK.length : i;
};
/** Sources whose items are many of one kind: these always render as a count. */
const COUNTED = Object.freeze({ doctor: ["check", "checks"], jobs: ["job", "jobs"], work: ["item", "items"] });

/** A short tag for one item, for the subjects list. */
function tagOf(it) {
  // A doctor label's topic: the first word that is not a hyphenated qualifier ("path-scoped rules ..." is "rules"),
  // up to its first dot ("docs.supersedes_unresolvable == 0" is "docs").
  if (it.signal === "doctor") {
    const words = String(it.what).split(/\s+/).filter(Boolean);
    const w = words.find((x) => !x.includes("-")) ?? words[0] ?? "check";
    return w.split(/[._:(=<>]/).find(Boolean) ?? "check";
  }
  return String(it.what);
}

/**
 * The problem items, grouped by source and ordered: needs-you sources, then broken (unknown included), each by
 * SOURCE_RANK, then by width.
 */
export function sourceGroups(items) {
  const by = new Map();
  for (const it of items) {
    if (it.verdict === "working" || it.ack) continue; // an acked item has its own line (ackedLine)
    if (!by.has(it.signal)) by.set(it.signal, []);
    by.get(it.signal).push(it);
  }
  const groups = [...by].map(([signal, its]) => {
    const needs = its.filter((i) => i.verdict === "needs_you").sort((a, b) => sinceMs(a) - sinceMs(b));
    const broken = its.filter((i) => i.verdict === "broken" && i.flag !== "unknown").sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || sinceMs(a) - sinceMs(b));
    const unknown = its.filter((i) => i.verdict === "broken" && i.flag === "unknown");
    const state = needs.length ? "needs_you" : broken.length ? "broken" : "unknown";
    const ordered = [...needs, ...broken, ...unknown];
    return { signal, state, needs, broken, unknown, items: ordered, top: ordered[0], width: its.reduce((a, i) => a + (i.count ?? 1), 0) };
  });
  const stateRank = (s) => (s === "needs_you" ? 0 : 1);
  return groups.sort((a, b) => stateRank(a.state) - stateRank(b.state) || rankOf(a.signal) - rankOf(b.signal) || b.width - a.width);
}

/** The display name of a source. */
export const sourceName = (g) => (g.signal === "metrics" ? "doctor history" : g.signal);

/** `<count> <verdict>` for a counted source, or the single item's `what` with a verdict word guaranteed. */
export function countText(g) {
  if (!COUNTED[g.signal] && g.items.length === 1) {
    const it = g.top;
    if (it.flag === "unknown") return `unknown, ${it.what}`;
    if (it.verdict === "needs_you") return `needs you: ${it.what}`;
    return /\b(broken|fail\w*|error\w*|stuck|silent)\b/i.test(it.what) ? it.what : `failing: ${it.what}`;
  }
  const noun = (n) => (COUNTED[g.signal] ? ` ${COUNTED[g.signal][n === 1 ? 0 : 1]}` : "");
  const parts = [];
  if (g.needs.length) parts.push(`${g.needs.length}${noun(g.needs.length)} ${g.needs.length === 1 ? "needs" : "need"} you`);
  if (g.broken.length) parts.push(`${g.broken.length}${parts.length ? "" : noun(g.broken.length)} failing`);
  if (g.unknown.length) parts.push(`${g.unknown.length} unknown`);
  return parts.join(", ");
}

/** `(a, b, c…)` holding as many distinct tags as fit in `room`, never cutting one; "" when none fits. */
export function subjectsText(g, room) {
  if (!COUNTED[g.signal] && g.items.length === 1) return "";
  const tags = [...new Set(g.items.map(tagOf))];
  let out = "";
  for (let i = 0; i < tags.length; i++) {
    const more = i < tags.length - 1;
    const next = `${out ? `${out}, ` : ""}${tags[i]}`;
    if (` (${next}${more ? "…" : ""})`.length > room) return out ? ` (${out}…)` : "";
    out = next;
  }
  return out ? ` (${out})` : "";
}

/** One source line, plain and (when `color`) painted; the 80-character rule is on the plain text. */
export function sourceLine(g, { color = false } = {}) {
  const head = `${sourceName(g)}: `;
  const fix = ` · ${g.top.fix?.text ?? "propagate glance --json"}`;
  const kind = g.state;
  let count = countText(g);
  const fixed = BADGE_WIDTH + 1 + head.length + fix.length;
  count = clipWords(count, Math.max(MAX_LINE - fixed, 4));
  const subjects = subjectsText(g, MAX_LINE - fixed - count.length);
  const plain = `${badge(kind, false)} ${head}${count}${subjects}${fix}`;
  if (!color) return plain;
  return `${badge(kind, true)} ${paint("bold", sourceName(g))}: ${count}${paint("dim", `${subjects}${fix}`)}`;
}

/** The OK line (working, not learning) and the LEARNING line. */
export function workingLines(items, generatedAtMs, { color = false } = {}) {
  const working = items.filter((i) => i.verdict === "working");
  const plain = [...new Set(working.filter((i) => i.flag !== "learning").map((i) => i.signal))].sort((a, b) => rankOf(a) - rankOf(b));
  const learning = working.filter((i) => i.flag === "learning");
  const out = [];
  const line = (kind, names, tail) => {
    const room = MAX_LINE - BADGE_WIDTH - 1 - tail.length;
    let list = "";
    for (let i = 0; i < names.length; i++) {
      const next = `${list ? `${list}, ` : ""}${names[i]}`;
      if (next.length + (i < names.length - 1 ? 1 : 0) > room) { list = `${list}…`; break; }
      list = next;
    }
    const text = `${list}${tail}`;
    return color ? `${badge(kind, true)} ${list}${paint("dim", tail)}` : `${badge(kind, false)} ${text}`;
  };
  if (plain.length) out.push(line("ok", plain, ` · checked ${hhmm(generatedAtMs)}`));
  if (learning.length) {
    const names = [...new Set(learning.map((i) => i.signal))];
    const have = Math.min(...learning.map((i) => Number(/(\d+) of 3/.exec(i.fix?.text ?? "")?.[1] ?? 0)));
    out.push(line("learning", names, ` · baseline ${have} of 3 days`));
  }
  return out;
}

/** One `[ACKED]` line for the problem items someone acknowledged or snoozed (propagate#296), or null. */
export function ackedLine(items, { color = false } = {}) {
  const acked = items.filter((i) => i.verdict !== "working" && i.ack);
  if (!acked.length) return null;
  const names = [...new Set(acked.map((i) => (i.signal === "metrics" ? "doctor history" : i.signal)))].sort((a, b) => rankOf(a) - rankOf(b));
  const tail = ` · ${acked.length} acknowledged; propagate glance --json`;
  const room = MAX_LINE - BADGE_WIDTH - 1 - tail.length;
  let list = "";
  for (let i = 0; i < names.length; i++) {
    const next = `${list ? `${list}, ` : ""}${names[i]}`;
    if (next.length + (i < names.length - 1 ? 1 : 0) > room) { list = `${list}…`; break; }
    list = next;
  }
  return color ? `${badge("acked", true)} ${list}${paint("dim", tail)}` : `${badge("acked", false)} ${list}${tail}`;
}

/**
 * The terminal view of a glance.
 * @param {object} glance a glance.json object
 * @param {{cap?: number, color?: boolean}} [opts]
 * @returns {string[]}
 */
export function renderLines(glance, { cap = TERMINAL_CAP, color = false } = {}) {
  if (glance.verdict === "blind") return [`${badge("unknown", color)} glance: nothing to read yet`];
  const at = Date.parse(glance.generatedAt);
  const groups = sourceGroups(glance.items);
  const acked = ackedLine(glance.items, { color });
  if (!groups.length && acked) return [acked, ...workingLines(glance.items, at, { color })];
  if (!groups.length) {
    const tail = ` · ${glance.signals_checked} signals checked · ${hhmm(at)}`;
    return [color ? `${badge("ok", true)} all clear${paint("dim", tail)}` : `${badge("ok", false)} all clear${tail}`];
  }
  const out = groups.slice(0, cap).map((g) => sourceLine(g, { color }));
  if (groups.length > cap) {
    const more = `+${groups.length - cap} more sources: propagate glance --json`;
    out.push(color ? paint("dim", more) : more);
  }
  if (acked) out.push(acked);
  out.push(...workingLines(glance.items, at, { color }));
  return out;
}
