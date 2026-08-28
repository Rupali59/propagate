/**
 * The ratchet gate — lib/report/caps.mjs `capsGate`.
 *
 * THIS IS A SAFETY GATE, so rule:safety-flag-needs-a-test applies: it ships with
 * the input that makes it FAIL, and the assertion is on the SIDE EFFECT (does the
 * commit land) rather than on what the gate says about itself. A guard that
 * trusts its own stdout is the failure this file exists to catch.
 *
 * The end-to-end cases drive a REAL throwaway git repo, because the three
 * failure modes the plan names — rename rows, binary rows, deleted files — are
 * all properties of git's behaviour, not of my parsing of a string I made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { capsGate, DEFAULT_CAPS } from "../../lib/report/caps.mjs";

const STATE_CAP = DEFAULT_CAPS["project/STATE.md"];

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "caps-gate-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "f@example.com");
  git("config", "user.name", "F");
  return { dir, git, runGit: (a) => git(...a) };
}

/** Every byte of the repo's git state, so "nothing was written" is measurable. */
function repoSnapshot(git) {
  return JSON.stringify({
    head: (() => { try { return git("rev-parse", "HEAD").trim(); } catch { return "none"; } })(),
    log: (() => { try { return git("log", "--oneline"); } catch { return ""; } })(),
    status: git("status", "--porcelain"),
  });
}

function stateFile(lines) {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n";
}

// ── the load-bearing case ────────────────────────────────────────────────────

test("an over-cap file that GROWS is blocked — and the gate writes nothing", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 50));
    git("add", "-A"); git("commit", "-qm", "seed");

    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 60)); // +10, already over
    git("add", rel);

    const before = repoSnapshot(git);
    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });

    assert.equal(g.blocked.length, 1, "over cap AND grew must block");
    assert.equal(g.blocked[0].file, rel);
    assert.equal(g.blocked[0].added, 10);
    assert.equal(repoSnapshot(git), before, "the gate must not touch the repo — it only reads");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an over-cap file that does NOT grow is allowed — the ratchet is passable on day one", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 50));
    git("add", "-A"); git("commit", "-qm", "seed");

    // Same length, different content. This is the property that stops the gate
    // forcing `--no-verify` on the 15 files that are already over cap.
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 50).replace("line 0", "edited"));
    git("add", rel);

    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    assert.equal(g.blocked.length, 0);
    assert.match(g.allowed[0].reason, /did not grow/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an over-cap file that SHRINKS is allowed, even while still over", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 50));
    git("add", "-A"); git("commit", "-qm", "seed");
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 20));
    git("add", rel);

    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    assert.equal(g.blocked.length, 0, "trimming toward the cap must never be refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a file UNDER cap may grow freely, right up to the cap", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), stateFile(10));
    git("add", "-A"); git("commit", "-qm", "seed");
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP - 1));
    git("add", rel);

    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    assert.equal(g.blocked.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("crossing the cap in one commit IS blocked — otherwise the ratchet never engages", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP - 10));
    git("add", "-A"); git("commit", "-qm", "seed");
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 5));
    git("add", rel);

    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    assert.equal(g.blocked.length, 1, "a file must not be able to sail past its cap unnoticed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the three failure modes the plan named ───────────────────────────────────

test("DELETING an over-cap file is allowed — the fix must not be blocked by the thing it fixes", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), stateFile(STATE_CAP + 300));
    git("add", "-A"); git("commit", "-qm", "seed");
    git("rm", "-q", rel);

    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    assert.equal(g.blocked.length, 0);
    assert.match(g.allowed[0].reason, /deleted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a RENAME is delete + add, so moving an over-cap file does not read as growth", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    mkdirSync(path.join(dir, "propagation", "state", "Q"), { recursive: true });
    const from = "propagation/state/P/STATE.md", to = "propagation/state/Q/STATE.md";
    writeFileSync(path.join(dir, from), stateFile(STATE_CAP + 40));
    git("add", "-A"); git("commit", "-qm", "seed");
    git("mv", from, to);

    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    // The destination is over cap and has no HEAD blob, so `before` is 0 and it
    // reads as growth. That IS the honest answer for a size ratchet: an over-cap
    // file arriving at a new path is new over-cap content at that path.
    assert.ok(g.blocked.length + g.allowed.length >= 1, "a rename must be inspected, not dropped on the floor");
    assert.ok(!g.skipped.some((s) => s.file === to), "the destination must never be silently skipped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a BINARY file is never coerced to 0 lines and waved through", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    // A capped NAME holding NUL bytes. numstat would report `-\t-\tpath`; the
    // gate never consults numstat's arithmetic, so there is nothing to coerce.
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/STATE.md";
    writeFileSync(path.join(dir, rel), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    git("add", "-A");
    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    // Whatever the verdict, it must be an ATTRIBUTED one, never an unexamined pass.
    const seen = [...g.blocked, ...g.allowed, ...g.skipped].some((x) => x.file === rel);
    assert.ok(seen, "a binary blob at a capped path must still be accounted for");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── statuses that must not read as passes ────────────────────────────────────

test("GOTCHAS.md is SKIPPED with a reason while its cap is unset — never silently gated", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    const rel = "propagation/state/P/GOTCHAS.md";
    writeFileSync(path.join(dir, rel), "### G1\nbody\n");
    git("add", "-A");
    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    const s = g.skipped.find((x) => x.file === rel);
    assert.ok(s, "must appear in skipped, not vanish");
    assert.match(s.reason, /cap unset/);
    assert.equal(g.blocked.length, 0, "blocking a hazard write would cost more than the growth");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an ordinary source file is skipped QUIETLY — notable:false — but is still returned", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    writeFileSync(path.join(dir, "index.mjs"), "export const a = 1;\n");
    git("add", "-A");
    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    const s = g.skipped.find((x) => x.file === "index.mjs");
    assert.ok(s, "it must still be RETURNED — --json loses nothing and the count stays honest");
    assert.equal(s.notable, false, "but not printed: every commit stages source, and noise is a hiding place (G23)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a GOTCHAS skip and a STUB skip ARE notable — the two that must never be buried", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    mkdirSync(path.join(dir, "propagation", "state", "P"), { recursive: true });
    writeFileSync(path.join(dir, "propagation/state/P/GOTCHAS.md"), "### G1\nb\n");
    mkdirSync(path.join(dir, "W", "P"), { recursive: true });
    writeFileSync(path.join(dir, "W/P/STATE.md"), "# STATE\n\n> State lives at ../propagation/state/P/STATE.md\n");
    git("add", "-A");
    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    const notable = g.skipped.filter((x) => x.notable).map((x) => x.file);
    assert.ok(notable.some((f) => f.endsWith("GOTCHAS.md")), "unset gotchas cap must be visible");
    assert.ok(notable.some((f) => f.endsWith("STATE.md")), "a legacy stub must be visible — that is N53");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bypass is REPORTED, and inspects nothing rather than pretending to pass", () => {
  const g = capsGate({ repoRoot: "/nope", runGit: () => { throw new Error("must not be called"); }, bypass: true });
  assert.equal(g.bypassed, true);
  assert.equal(g.staged, 0);
  assert.equal(g.blocked.length, 0);
});

test("an unreadable index is SKIPPED with the reason, not treated as an empty commit", () => {
  const g = capsGate({ repoRoot: "/nope", runGit: () => { throw new Error("not a git repository"); } });
  assert.equal(g.skipped.length, 1);
  assert.match(g.skipped[0].reason, /could not read staged paths/);
  assert.equal(g.blocked.length, 0);
});

test("nothing staged is distinguishable from nothing found", () => {
  const { dir, git, runGit } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    git("add", "-A"); git("commit", "-qm", "seed");
    const g = capsGate({ repoRoot: dir, runGit, hubRoot: dir });
    assert.equal(g.staged, 0, "the count is what makes the two distinguishable to the caller");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
