/**
 * context.mjs — how much model context the gotcha-guard injects, per compaction window (#225).
 *
 * WHY THIS EXISTS. `doctor` measured nothing about injection volume, so a guard that re-sent every
 * matching entry's full body on every hit grew to 830k chars in one transcript with no signal. The
 * number is derived from a session transcript, never remembered (`rule:derive-dont-curate`).
 *
 * WHAT IS COUNTED, AND WHAT IS NOT. Only `hook_additional_context` attachments: that is the channel
 * the model reads. The guard also writes `systemMessage`, which a transcript records as a separate
 * `hook_system_message` attachment carrying the same text; it costs the model nothing, and counting
 * it doubles every figure (`rule:measure-the-claim-not-a-proxy`).
 *
 * A "showing" is one `gotcha · ` header at the start of a line (one entry delivered once);
 * an "injection" is one attachment holding at least one showing. Chars are the lengths of the content
 * strings that hold a showing. A window is the span between two `compact_boundary` records (the
 * first window runs from the start of the file).
 *
 * PURE: takes parsed records, returns a report. The caller reads the file.
 */

export const MARKER = "gotcha · ";
const SHOWING_RE = /^gotcha · /gm;

/**
 * @param {object[]} records parsed transcript lines, in file order
 * @returns {{windows: {window: number, injections: number, showings: number, chars: number}[],
 *   total: {injections: number, showings: number, chars: number}, additionalContextRecords: number}}
 */
export function gotchaContextByWindow(records) {
  const windows = [{ window: 1, injections: 0, showings: 0, chars: 0 }];
  let additionalContextRecords = 0;
  for (const r of records) {
    if (r?.type === "system" && r?.subtype === "compact_boundary") {
      windows.push({ window: windows.length + 1, injections: 0, showings: 0, chars: 0 });
      continue;
    }
    const a = r?.attachment;
    if (a?.type !== "hook_additional_context") continue;
    additionalContextRecords++;
    const strings = (Array.isArray(a.content) ? a.content : [a.content]).filter((s) => typeof s === "string");
    const w = windows[windows.length - 1];
    let hit = false;
    for (const s of strings) {
      const n = (s.match(SHOWING_RE) || []).length;
      if (n === 0) continue;
      hit = true;
      w.showings += n;
      w.chars += s.length;
    }
    if (hit) w.injections++;
  }
  const total = windows.reduce(
    (t, w) => ({ injections: t.injections + w.injections, showings: t.showings + w.showings, chars: t.chars + w.chars }),
    { injections: 0, showings: 0, chars: 0 },
  );
  return { windows, total, additionalContextRecords };
}
