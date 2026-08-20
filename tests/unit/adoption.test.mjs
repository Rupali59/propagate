/**
 * lib/adoption.mjs — the adoption trigger (task brief Component 1). Pure
 * parsing/selection logic over synthetic SYSTEMS.md-shaped text; never
 * touches the real docs/SYSTEMS.md or writes anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitTableRow,
  parseSystemsTable,
  isAdoptionBlank,
  leadingDate,
  adoptionCandidates,
  pickAdoptionAsk,
  formatAdoptionLines,
  PINNED_FIRST_ID,
} from "../../lib/report/adoption.mjs";

const HEADER =
  "| id | kind | status | supersedes / superseded_by | artifacts | liveness_probe | last_verified | adoption_date | retirement_checklist_done |";

function row({ id, status, artifacts = "art", probe = "echo ok", lastVerified = "2026-08-14", adoption = "— *not earned*", retirement = "n/a" }) {
  return `| \`${id}\` | kind | ${status} | — | ${artifacts} | ${probe} | ${lastVerified} | ${adoption} | ${retirement} |`;
}

// ─────────────────────────────────────────────────────────────────────────
// Escaped-pipe-aware row splitting — the bug that would silently misalign
// every later column if `line.split("|")` were used instead.
// ─────────────────────────────────────────────────────────────────────────

test("splitTableRow treats an escaped pipe as a literal char, not a delimiter", () => {
  const cells = splitTableRow("| `x` | probe with \\| inside | last | done |");
  assert.deepEqual(cells, ["`x`", "probe with | inside", "last", "done"]);
});

test("parseSystemsTable does not misalign columns for a row containing an escaped pipe mid-cell", () => {
  const text = [
    HEADER,
    row({ id: "escaped", status: "active-unadopted", probe: "cmd \\| grep -c x", adoption: "**BLANK**" }),
  ].join("\n");
  const rows = parseSystemsTable(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "escaped");
  assert.equal(rows[0].liveness_probe, "cmd | grep -c x");
  assert.equal(rows[0].adoption_date, "BLANK");
});

// ─────────────────────────────────────────────────────────────────────────
// Blank detection — must match SYSTEMS.md's real spellings and must NOT
// treat a real (if terse) answer like "never" or "n/a" as blank.
// ─────────────────────────────────────────────────────────────────────────

test("isAdoptionBlank recognises the real spellings used in SYSTEMS.md", () => {
  assert.equal(isAdoptionBlank("**BLANK**"), true);
  assert.equal(isAdoptionBlank("BLANK"), true);
  assert.equal(isAdoptionBlank("**BLANK — do not fill until 2 weeks**"), true);
  assert.equal(isAdoptionBlank("— *not earned*"), true);
  assert.equal(isAdoptionBlank("*not yet earned*"), true);
  assert.equal(isAdoptionBlank(""), true);
});

test("isAdoptionBlank does NOT treat a real answer as blank", () => {
  assert.equal(isAdoptionBlank("never"), false);
  assert.equal(isAdoptionBlank("n/a"), false);
  assert.equal(isAdoptionBlank("2026-08-14 (confirmed by Rupali)"), false);
});

test("leadingDate extracts only a leading YYYY-MM-DD, never a guess from prose", () => {
  assert.equal(leadingDate("2026-08-10 (verified directly)"), "2026-08-10");
  assert.equal(leadingDate("n/a"), null);
  assert.equal(leadingDate("(see 2026-08-10 elsewhere)"), null);
  assert.equal(leadingDate(null), null);
});

// ─────────────────────────────────────────────────────────────────────────
// Candidate filtering — only the two target statuses, only blank cells.
// ─────────────────────────────────────────────────────────────────────────

test("adoptionCandidates excludes non-target statuses even with a blank cell", () => {
  const text = [
    HEADER,
    row({ id: "a", status: "active", adoption: "**BLANK**" }), // wrong status
    row({ id: "b", status: "proposed", adoption: "**BLANK**" }), // wrong status
    row({ id: "c", status: "active-unadopted", adoption: "**BLANK**" }), // qualifies
  ].join("\n");
  const rows = parseSystemsTable(text);
  const cands = adoptionCandidates(rows);
  assert.deepEqual(cands.map((r) => r.id), ["c"]);
});

test("adoptionCandidates excludes a target-status row whose adoption_date is filled", () => {
  const text = [HEADER, row({ id: "ollama-like", status: "installed-never-invoked", adoption: "never" })].join("\n");
  const rows = parseSystemsTable(text);
  assert.deepEqual(adoptionCandidates(rows), []);
});

// ─────────────────────────────────────────────────────────────────────────
// Selection: exactly one, deterministic, daily-md pinned first.
// ─────────────────────────────────────────────────────────────────────────

test("pickAdoptionAsk returns null when there is nothing to ask", () => {
  const text = [HEADER, row({ id: "fine", status: "active", adoption: "2026-08-14" })].join("\n");
  assert.equal(pickAdoptionAsk(parseSystemsTable(text)), null);
});

test("pickAdoptionAsk pins daily-md first even when another row is verified earlier (would otherwise be 'oldest')", () => {
  const text = [
    HEADER,
    row({ id: "older-row", status: "active-unadopted", lastVerified: "2026-08-01", adoption: "**BLANK**" }),
    row({ id: PINNED_FIRST_ID, status: "installed-never-invoked", lastVerified: "2026-08-14", adoption: "**BLANK**" }),
  ].join("\n");
  const ask = pickAdoptionAsk(parseSystemsTable(text));
  assert.equal(ask.id, PINNED_FIRST_ID);
  assert.equal(ask.isCircularityExample, true);
  assert.equal(ask.candidateCount, 2);
});

test("pickAdoptionAsk, absent the pinned row, picks the oldest by last_verified ascending", () => {
  const text = [
    HEADER,
    row({ id: "newer", status: "active-unadopted", lastVerified: "2026-08-14", adoption: "**BLANK**" }),
    row({ id: "oldest", status: "active-unadopted", lastVerified: "2026-08-01", adoption: "**BLANK**" }),
    row({ id: "middle", status: "active-unadopted", lastVerified: "2026-08-07", adoption: "**BLANK**" }),
  ].join("\n");
  const ask = pickAdoptionAsk(parseSystemsTable(text));
  assert.equal(ask.id, "oldest");
  assert.equal(ask.isCircularityExample, false);
});

test("pickAdoptionAsk is deterministic — same input, same output, across repeated calls", () => {
  const text = [
    HEADER,
    row({ id: "a", status: "active-unadopted", lastVerified: "2026-08-05", adoption: "**BLANK**" }),
    row({ id: "b", status: "active-unadopted", lastVerified: "2026-08-05", adoption: "**BLANK**" }),
  ].join("\n");
  const rows = parseSystemsTable(text);
  const first = pickAdoptionAsk(rows);
  const second = pickAdoptionAsk(rows);
  assert.equal(first.id, second.id);
  // Tie-broken by id, not by call order/randomness.
  assert.equal(first.id, "a");
});

test("pickAdoptionAsk never writes adoption_date — the returned object carries no such field, and the source rows are untouched", () => {
  const text = [HEADER, row({ id: "x", status: "active-unadopted", adoption: "**BLANK**" })].join("\n");
  const rows = parseSystemsTable(text);
  const beforeAdoption = rows[0].adoption_date;
  const ask = pickAdoptionAsk(rows);
  assert.equal(rows[0].adoption_date, beforeAdoption, "row must be unmutated");
  assert.equal("adoption_date" in ask, false);
  assert.equal(Object.prototype.hasOwnProperty.call(ask, "adoption_date"), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Rendering — never a list, states why, never proposes a value.
// ─────────────────────────────────────────────────────────────────────────

test("formatAdoptionLines renders zero lines for a null ask", () => {
  assert.deepEqual(formatAdoptionLines(null), []);
});

test("formatAdoptionLines names the row, its age proxy, its liveness_probe, and the three-way question", () => {
  const text = [
    HEADER,
    row({ id: "queue-ui", status: "active-unadopted", lastVerified: "2026-08-10", probe: "curl -s localhost:8790", adoption: "**BLANK**" }),
  ].join("\n");
  const ask = pickAdoptionAsk(parseSystemsTable(text));
  const lines = formatAdoptionLines(ask).join("\n");
  assert.match(lines, /queue-ui/);
  assert.match(lines, /curl -s localhost:8790/);
  assert.match(lines, /earned it\? retire it\? or not yet/);
  assert.doesNotMatch(lines, /adoption_date:\s*\d{4}/, "must never propose a date value");
});

test("formatAdoptionLines' circularity line only fires for the pinned row", () => {
  const text = [HEADER, row({ id: PINNED_FIRST_ID, status: "installed-never-invoked", adoption: "**BLANK**" })].join("\n");
  const ask = pickAdoptionAsk(parseSystemsTable(text));
  const lines = formatAdoptionLines(ask).join("\n");
  assert.match(lines, /this digest's own generated artifact is unadopted too/);
});
