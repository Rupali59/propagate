/**
 * #298 (glance PR5): retirement candidates, by extending lib/report/adoption.mjs.
 *
 * The contract, from the issue's "Done when" and the design's §7:
 *   - SYSTEMS.md is parsed by HEADER NAME, not column position. Before this, a
 *     7-column table put `adoption_date` on `null`, `isAdoptionBlank(null)` is false,
 *     and the scan found 0 candidates silently (eng review B6).
 *   - a table missing a required header is UNREADABLE, with its path, never 0 candidates;
 *   - plain `active` stays excluded (ruling 2026-11-16);
 *   - a worktree copy of a workspace's SYSTEMS.md is counted once;
 *   - no SYSTEMS.md at all prints a blind-scan line naming the workspaces scanned;
 *   - digest and doctor take their candidates from ONE function.
 *
 * Synthetic workspaces under a temp dir only: no real workspace, system or label name.
 */
// @size medium — temp-dir fixtures and one real `git worktree add`

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  parseSystems,
  parseSystemsTable,
  adoptionCandidates,
  classifyAdoptionRows,
  classifyRetirementRows,
  RETIREMENT_MIN_DAYS,
  scanRetirement,
  scanSystems,
  ADOPTION_TARGET_STATUSES,
} from "../../lib/report/adoption.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkRetirement } from "../../lib/report/doctor/retirement.mjs";
import { adoptionSnapshot } from "../../digest.mjs";

// The 7-column shape some workspaces use: no `supersedes`, no `retirement_checklist_done`.
const HEADER_7 = "| id | kind | status | artifacts | liveness_probe | last_verified | adoption_date |";
const SEP_7 = "|---|---|---|---|---|---|---|";
const row7 = ({ id, status = "active-unadopted", lastVerified = "2026-08-01", adoption = "**BLANK**" }) =>
  `| \`${id}\` | agent | ${status} | art | echo ok | ${lastVerified} | ${adoption} |`;

// The same columns, reordered: adoption_date first after id, status last.
const HEADER_REORDERED = "| id | adoption_date | last_verified | liveness_probe | artifacts | kind | status |";
const SEP_REORDERED = SEP_7;
const rowReordered = ({ id, status = "active-unadopted", lastVerified = "2026-08-01", adoption = "**BLANK**" }) =>
  `| \`${id}\` | ${adoption} | ${lastVerified} | echo ok | art | agent | ${status} |`;

const sevenCol = (...rows) => [HEADER_7, SEP_7, ...rows].join("\n");

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "retirement-"));
}

function putSystems(root, text, rel = path.join("docs", "SYSTEMS.md")) {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text, "utf8");
  return f;
}

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

// ─────────────────────────────────────────────────────────────────────────
// T-A1: header-keyed parse
// ─────────────────────────────────────────────────────────────────────────

test("a 7-column SYSTEMS.md finds its candidate (positional parsing found 0 silently)", () => {
  const { rows, error } = parseSystems(sevenCol(row7({ id: "sys-alpha" })));
  assert.equal(error, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].adoption_date, "BLANK");
  assert.equal(rows[0].last_verified, "2026-08-01");
  assert.deepEqual(adoptionCandidates(rows).map((r) => r.id), ["sys-alpha"]);
});

test("reordered columns find the same candidate as the 7-column order", () => {
  const a = parseSystems(sevenCol(row7({ id: "sys-alpha" })));
  const b = parseSystems([HEADER_REORDERED, SEP_REORDERED, rowReordered({ id: "sys-alpha" })].join("\n"));
  assert.equal(b.error, null);
  const pick = (rows) => adoptionCandidates(rows).map((r) => [r.id, r.status, r.last_verified, r.adoption_date]);
  assert.deepEqual(pick(b.rows), pick(a.rows));
  assert.equal(pick(b.rows).length, 1);
});

test("the 9-column header (with `supersedes / superseded_by`) still parses", () => {
  const header =
    "| id | kind | status | supersedes / superseded_by | artifacts | liveness_probe | last_verified | adoption_date | retirement_checklist_done |";
  const text = [header, "|---|---|---|---|---|---|---|---|---|", "| `sys-beta` | k | installed-never-invoked | — | a | p | 2026-08-02 | — *not earned* | n/a |"].join("\n");
  const { rows, error } = parseSystems(text);
  assert.equal(error, null);
  assert.deepEqual(adoptionCandidates(rows).map((r) => r.id), ["sys-beta"]);
});

// ─────────────────────────────────────────────────────────────────────────
// Missing header: unreadable, with the path, never 0 candidates
// ─────────────────────────────────────────────────────────────────────────

test("a table missing a required header is unreadable, naming the missing header", () => {
  const text = ["| id | kind | status | last_verified |", "|---|---|---|---|", "| `sys-gamma` | k | active-unadopted | 2026-08-01 |"].join("\n");
  const { rows, error } = parseSystems(text);
  assert.deepEqual(rows, []);
  assert.match(error, /adoption_date/);
  assert.throws(() => parseSystemsTable(text), /adoption_date/, "the rows-only parser must not return a silent []");
});

test("scan: an unreadable SYSTEMS.md is reported with its path, and doctor says unreadable, not 0 candidates", () => {
  const root = tmp();
  try {
    const f = putSystems(path.join(root, "ws-alpha"), ["| restart | count |", "|---|---|", "| `always` | 9 |"].join("\n"));
    const scan = scanRetirement({ workspaces: [{ name: "ws-alpha", root: path.join(root, "ws-alpha") }], skillDir: null });
    assert.equal(scan.unreadable.length, 1);
    assert.equal(scan.unreadable[0].path, f);
    assert.equal(scan.candidates.length, 0);

    const r = new Reporter();
    checkRetirement({ reporter: r, scan });
    const text = r.entries.map((e) => `${e.label} ${e.detail}`).join("\n");
    assert.match(text, /unreadable/);
    assert.ok(text.includes(f), "the unreadable line names the file path");
    assert.doesNotMatch(text, /\b0 candidates\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// T-A2: plain `active` stays excluded
// ─────────────────────────────────────────────────────────────────────────

test("the digest ask: a plain `active` row with a blank adoption_date stays excluded", () => {
  assert.deepEqual([...ADOPTION_TARGET_STATUSES], ["active-unadopted", "installed-never-invoked"]);
  const { rows } = parseSystems(sevenCol(row7({ id: "sys-plain", status: "active" }), row7({ id: "sys-target", status: "active-unadopted" })));
  assert.deepEqual(adoptionCandidates(rows).map((r) => r.id), ["sys-target"]);
});

// ─────────────────────────────────────────────────────────────────────────
// T-A3: no parseable start date is unknown, never a candidate
// ─────────────────────────────────────────────────────────────────────────

test("a target row with no parseable last_verified is `unknown: no start date`, not a candidate", () => {
  const { rows } = parseSystems(sevenCol(row7({ id: "sys-undated", lastVerified: "n/a" }), row7({ id: "sys-dated" })));
  const { candidates, unknown } = classifyAdoptionRows(rows);
  assert.deepEqual(candidates.map((r) => r.id), ["sys-dated"]);
  assert.deepEqual(unknown.map((r) => r.id), ["sys-undated"]);

  const r = new Reporter();
  checkRetirement({ reporter: r, scan: { scanned: 1, sources: [{ path: "/x/docs/SYSTEMS.md", workspace: "ws", rows: rows.length }], duplicates: [], unreadable: [], candidates: candidates.map((c) => ({ ...c, source: "/x/docs/SYSTEMS.md", workspace: "ws" })), unknown: unknown.map((c) => ({ ...c, source: "/x/docs/SYSTEMS.md", workspace: "ws" })) } });
  assert.ok(r.entries.some((e) => /sys-undated/.test(`${e.label} ${e.detail}`) && /unknown: no start date/.test(e.detail)));
});

// ─────────────────────────────────────────────────────────────────────────
// T-A5: a worktree copy is counted once
// ─────────────────────────────────────────────────────────────────────────

test("a worktree copy of a workspace's SYSTEMS.md is counted once", () => {
  const root = tmp();
  try {
    const main = path.join(root, "ws-alpha");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q");
    putSystems(main, sevenCol(row7({ id: "sys-alpha" })));
    git(main, "add", "-A");
    git(main, "commit", "-q", "--no-verify", "-m", "init");
    const wt = path.join(root, "worktrees", "ws-alpha-copy");
    git(main, "worktree", "add", "-q", "--detach", wt);

    const workspaces = [
      { name: "ws-alpha", root: main },
      { name: "ws-alpha-copy", root: wt },
    ];
    const scan = scanRetirement({ workspaces, skillDir: null });
    assert.equal(scan.sources.length, 1, `one source, got ${JSON.stringify(scan.sources)}`);
    assert.equal(scan.sources[0].workspace, "ws-alpha", "the main checkout wins over its worktree");
    assert.equal(scan.duplicates.length, 1);
    assert.deepEqual(scan.candidates.map((c) => c.id), ["sys-alpha"]);

    // Listed worktree-first, the main checkout still wins.
    const rev = scanRetirement({ workspaces: [...workspaces].reverse(), skillDir: null });
    assert.equal(rev.sources.length, 1);
    assert.equal(rev.sources[0].workspace, "ws-alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same file reached twice (skillDir inside a scanned workspace) is counted once", () => {
  const root = tmp();
  try {
    const ws = path.join(root, "ws-alpha");
    putSystems(ws, sevenCol(row7({ id: "sys-alpha" })));
    const scan = scanRetirement({ workspaces: [{ name: "ws-alpha", root: ws }], skillDir: ws });
    assert.equal(scan.sources.length, 1);
    assert.equal(scan.candidates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a per-project SYSTEMS.md under <workspace>/docs/<project>/ is found (rule:workspace-docs-layout)", () => {
  const root = tmp();
  try {
    const ws = path.join(root, "ws-alpha");
    putSystems(ws, sevenCol(row7({ id: "sys-proj" })), path.join("docs", "proj-one", "SYSTEMS.md"));
    const scan = scanRetirement({ workspaces: [{ name: "ws-alpha", root: ws }], skillDir: null });
    assert.deepEqual(scan.candidates.map((c) => c.id), ["sys-proj"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// T-A4: blind scan
// ─────────────────────────────────────────────────────────────────────────

test("no SYSTEMS.md anywhere prints the blind-scan line naming the workspaces scanned, never `0 candidates`", () => {
  const root = tmp();
  try {
    const workspaces = ["ws-alpha", "ws-beta", "ws-gamma"].map((name) => {
      mkdirSync(path.join(root, name, "docs"), { recursive: true });
      return { name, root: path.join(root, name) };
    });
    const scan = scanRetirement({ workspaces, skillDir: null });
    assert.equal(scan.sources.length, 0);
    assert.equal(scan.scanned, 3);

    const r = new Reporter();
    checkRetirement({ reporter: r, scan });
    const text = r.entries.map((e) => `${e.label} ${e.detail}`).join("\n");
    assert.match(text, /retirement: no SYSTEMS\.md found in 3 workspaces scanned/);
    assert.doesNotMatch(text, /\b0 candidates\b/);
    assert.equal(r.problems, 0, "warn-only: a blind scan never votes on the exit code");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// T-A6: one scan, two rules (Rupali, 2026-11-16: "two rules")
//   the digest's adoption ask: the narrow ADOPTION_TARGET_STATUSES, unchanged;
//   doctor's retirement candidates: status starts `active`, adoption blank, and
//   more than RETIREMENT_MIN_DAYS since the earliest date in last_verified.
// ─────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-16T12:00:00Z");
const daysBefore = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

// Shaped like a real long-running agent row: the status is prose that opens with
// "active", emphasis included. Written as a literal, never through row7(), so the
// status cell keeps its markup (rule:mutate-behind-the-fixture-builder).
const WIDGET_SHAPED =
  "| `sys-sampler` | agent | **active, and since 2026-09-14 it drives two things** — a sample and a slow path | art | " +
  "echo ok | **2026-09-14** — three instruments agreed | **BLANK.** Not earned. |";

test("a widget-shaped row (`active, and since …`, blank adoption) is a retirement candidate 30+ days on, and NOT a digest ask", () => {
  const { rows, error } = parseSystems(sevenCol(WIDGET_SHAPED));
  assert.equal(error, null);
  const ret = classifyRetirementRows(rows, { now: NOW });
  assert.deepEqual(ret.candidates.map((r) => r.id), ["sys-sampler"]);
  assert.equal(ret.candidates[0].startDate, "2026-09-14");
  assert.ok(ret.candidates[0].ageDays > RETIREMENT_MIN_DAYS);
  assert.deepEqual(adoptionCandidates(rows), [], "the digest's narrow rule must not ask about it");
});

test("the retirement clock is the EARLIEST date in last_verified, not the leading one", () => {
  const text = sevenCol("| `sys-two-dates` | k | active | a | p | 2026-11-14 (re-run); first verified 2026-08-03 | |");
  const ret = classifyRetirementRows(parseSystems(text).rows, { now: NOW });
  assert.deepEqual(ret.candidates.map((r) => [r.id, r.startDate]), [["sys-two-dates", "2026-08-03"]]);
});

test("a row verified 10 days ago is not a retirement candidate (and not unknown)", () => {
  const ret = classifyRetirementRows(parseSystems(sevenCol(row7({ id: "sys-recent", status: "active", lastVerified: daysBefore(10) }))).rows, { now: NOW });
  assert.deepEqual(ret.candidates, []);
  assert.deepEqual(ret.unknown, []);
});

test("retired, dormant and proposed rows are excluded from retirement candidates", () => {
  const text = sevenCol(
    row7({ id: "sys-retired", status: "**retired 2026-08-14**" }),
    row7({ id: "sys-dormant", status: "dormant" }),
    row7({ id: "sys-proposed", status: "proposed — not installed" }),
    row7({ id: "sys-live", status: "Active" }),
  );
  const ret = classifyRetirementRows(parseSystems(text).rows, { now: NOW });
  assert.deepEqual(ret.candidates.map((r) => r.id), ["sys-live"]);
});

test("a retirement row with no parseable date is `unknown: no start date`, never a candidate", () => {
  const ret = classifyRetirementRows(parseSystems(sevenCol(row7({ id: "sys-undated", status: "active", lastVerified: "n/a" }))).rows, { now: NOW });
  assert.deepEqual(ret.candidates, []);
  assert.deepEqual(ret.unknown.map((r) => r.id), ["sys-undated"]);
});

test("digest and doctor read ONE scan and apply their own rule to it", () => {
  const root = tmp();
  try {
    const a = path.join(root, "ws-alpha");
    const b = path.join(root, "ws-beta");
    putSystems(a, sevenCol(row7({ id: "sys-alpha", lastVerified: "2026-08-03" }), row7({ id: "sys-plain", status: "active" }), WIDGET_SHAPED));
    putSystems(b, [HEADER_REORDERED, SEP_REORDERED, rowReordered({ id: "sys-beta", lastVerified: "2026-08-01" })].join("\n"));
    const opts = { workspaces: [{ name: "ws-alpha", root: a }, { name: "ws-beta", root: b }], skillDir: null };
    const ids = (list) => list.map((c) => `${c.workspace}:${c.id}`).sort();

    const scan = scanSystems(opts);
    assert.equal(scan.rows.length, 4);

    const digest = adoptionSnapshot(opts);
    assert.equal(digest.available, true);
    assert.deepEqual(ids(digest.candidates), ids(adoptionCandidates(scan.rows)));
    assert.deepEqual(ids(digest.candidates), ["ws-alpha:sys-alpha", "ws-beta:sys-beta"]);
    assert.equal(digest.ask.id, "sys-beta", "the digest's one ask is the oldest candidate across workspaces");

    const r = new Reporter();
    const { scan: doctorScan } = checkRetirement({ reporter: r, ...opts, now: NOW });
    const expected = ids(classifyRetirementRows(scan.rows, { now: NOW }).candidates);
    assert.deepEqual(ids(doctorScan.candidates), expected);
    assert.deepEqual(expected, ["ws-alpha:sys-alpha", "ws-alpha:sys-plain", "ws-alpha:sys-sampler", "ws-beta:sys-beta"]);
    const named = r.entries.filter((e) => e.kind === "warn" && e.label === "retirement candidate").map((e) => e.detail.split(" · ")[0]);
    assert.deepEqual(named.sort(), ["sys-alpha", "sys-beta", "sys-plain", "sys-sampler"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("digest reports the blind scan as unavailable, never as nothing to ask", () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "ws-alpha"), { recursive: true });
    const digest = adoptionSnapshot({ workspaces: [{ name: "ws-alpha", root: path.join(root, "ws-alpha") }], skillDir: null });
    assert.equal(digest.available, false);
    assert.match(digest.error, /no SYSTEMS\.md found in 1 workspaces scanned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
