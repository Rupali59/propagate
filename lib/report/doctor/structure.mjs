/**
 * structure.mjs — doctor's output, as data.
 *
 * WHY IT PARSES THE OUTPUT INSTEAD OF INSTRUMENTING THE REPORTER. The obvious
 * design is to have `Reporter` accumulate and emit its `entries[]` directly.
 * Measured before building: doctor prints **561 marked lines and 31 headers**,
 * and the doctor region of `cli.mjs` holds **31 direct `console.log` calls** that
 * never touch a Reporter. A reporter-only JSON would therefore be silently
 * INCOMPLETE — it would omit whole sections while looking whole, which is the
 * exact defect N87 filed against doctor itself (a report whose population
 * excluded the failures still printing a pass).
 *
 * Deriving from the rendered lines has one property the other approach cannot
 * offer: **the JSON and the text cannot disagree, because one is a function of
 * the other.** If a future section prints without a Reporter, it still appears.
 *
 * The classification is unambiguous because `renderDoctorEntries` in cli.mjs is
 * the single formatter and every marker is distinct:
 *
 *   `# <label>`   header      (BOLD, column 0)
 *   `  ✓ …`       pass
 *   `  ✗ …`       fail
 *   `  ! …`       warn
 *   `  · …`       info
 *   `  <text>`    note        (marker-less dim line, deliberately distinct from info)
 *
 * `detail` is separated from `label` by the two spaces the renderer emits.
 */

/** ANSI escapes must go before anything is classified; the markers are the contract. */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

const KIND_BY_MARKER = { "✓": "pass", "✗": "fail", "!": "warn", "·": "info" };

/**
 * One rendered line → a typed entry, or null when the line carries no entry
 * (blank lines, and the summary line doctor prints last).
 */
export function classifyLine(raw) {
  const line = stripAnsi(raw);
  if (!line.trim()) return null;

  if (/^#\s/.test(line)) return { kind: "header", label: line.replace(/^#\s+/, "").trim(), detail: "" };

  const m = /^\s{2}(\S)\s(.*)$/.exec(line);
  if (m && KIND_BY_MARKER[m[1]]) {
    const rest = m[2];
    // The renderer joins label and detail with exactly two spaces.
    const split = rest.indexOf("  ");
    return split === -1
      ? { kind: KIND_BY_MARKER[m[1]], label: rest.trim(), detail: "" }
      : { kind: KIND_BY_MARKER[m[1]], label: rest.slice(0, split).trim(), detail: rest.slice(split + 2).trim() };
  }

  if (/^\s{2}\S/.test(line)) return { kind: "note", label: line.trim(), detail: "" };
  return null; // doctor's own trailing summary line, and anything unindented
}

/**
 * Group classified entries into sections.
 *
 * Entries before the first header land in a section named `""` rather than
 * being dropped — "printed outside any section" is a fact worth keeping, and
 * silently discarding it is how a reader loses a line nobody knew existed.
 */
export function toSections(lines) {
  // SPLIT EMBEDDED NEWLINES FIRST. A captured `console.log` argument is not a
  // line — the renderer emits a header as `"\n# State"` in ONE call, so a naive
  // `^#` test sees a leading newline and every header is missed, collapsing the
  // whole run into a single section. Reading doctor's output from a FILE hides
  // this completely, because the file arrives already split, which is exactly
  // how the first version of this passed its test and failed in use.
  lines = (lines ?? []).flatMap((l) => String(l ?? "").split("\n"));

  const sections = [];
  let current = { name: "", pass: 0, warn: 0, fail: 0, info: 0, note: 0, entries: [] };
  let started = false;

  for (const raw of lines) {
    const e = classifyLine(raw);
    if (!e) continue;
    if (e.kind === "header") {
      if (started || current.entries.length) sections.push(current);
      current = { name: e.label, pass: 0, warn: 0, fail: 0, info: 0, note: 0, entries: [] };
      started = true;
      continue;
    }
    current[e.kind] += 1;
    current.entries.push(e);
  }
  if (started || current.entries.length) sections.push(current);
  return sections;
}

/**
 * The full payload.
 *
 * `problems` is taken from the CALLER's exit-code tally, never recounted from
 * `fail` entries. Doctor's own module doc warns that a summarised defect is
 * counted once by its check and again by a tally — recounting here would
 * reintroduce that double-vote in a second place.
 */
export function buildDoctorJson(lines, { problems, generatedAt }) {
  const sections = toSections(lines);
  const totals = sections.reduce(
    (a, s) => ({ pass: a.pass + s.pass, warn: a.warn + s.warn, fail: a.fail + s.fail, info: a.info + s.info, note: a.note + s.note }),
    { pass: 0, warn: 0, fail: 0, info: 0, note: 0 },
  );
  return { generatedAt, problems, totals, sectionCount: sections.length, sections };
}
