/**
 * A workspace that HOLDS state must be able to keep it.
 *
 * WHY THIS CHECK EXISTS. The v3 layout moved STATE/DECISIONS/GOTCHAS out of each
 * project and into the workspace. `rule:state-and-decisions` records that as a
 * deliberate trade — "a fresh clone of a project repo gets a pointer stub" — but
 * it assumed the workspace repo was backed. Measured 2026-08-26: **6 of 12
 * workspaces holding propagation state had no remote**, carrying 9 state files
 * that existed on one disk only.
 *
 * The sharpest case: `Anushka/thesis-frontend` HAS a remote, and its register had
 * been migrated into `Anushka/`, which did not. So the move took that file from
 * backed storage to unbacked storage, silently. The trade stopped being about
 * discoverability and became about durability, and nothing said so.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkWorkspace } from "../../lib/report/doctor/workspaces.mjs";

const LABEL = "workspace holding state has a remote";

/** A workspace root, optionally a git repo, optionally with state files. */
function fixture({ git = false, remote = null, stateFiles = 0 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ws-remote-"));
  if (stateFiles > 0) {
    const dir = path.join(root, "propagation", "state", "workspace");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < stateFiles; i++) writeFileSync(path.join(dir, `S${i}.md`), "# state\n");
  } else {
    mkdirSync(path.join(root, "propagation", "state"), { recursive: true });
  }
  if (git) {
    const q = { cwd: root, stdio: "ignore" };
    execFileSync("git", ["init", "-q"], q);
    if (remote) execFileSync("git", ["remote", "add", remote.name, remote.url], q);
  }
  return root;
}

const ws = (root) => ({
  name: path.basename(root),
  root,
  ledgerJsonl: path.join(root, "propagation", "ledger.jsonl"),
  ledgerMd: path.join(root, "propagation", "ledger.md"),
});

const entryFor = (r) => r.entries.find((e) => e.label === LABEL);

test("state in a repo with NO remote is a FAILURE, and names the count", async () => {
  // The failing case the coverage ratchet requires. A check nobody has seen fail
  // is not known to work (GOTCHAS G1).
  const root = fixture({ git: true, stateFiles: 2 });
  try {
    const r = new Reporter();
    await checkWorkspace({ ws: ws(root), sidecars: [], reporter: r });
    const e = entryFor(r);
    assert.ok(e, "the check must run at all");
    assert.equal(e.kind, "fail");
    assert.match(e.detail, /NO REMOTE and 2 state file/);
    assert.ok(r.problems >= 1, "and it must vote");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("ANY remote counts, not just `origin`", async () => {
  // The first version of this measurement used `git remote get-url origin` and
  // would have called a repo with a differently-named remote unbacked — an
  // instrument narrower than the claim, which is the error this tree keeps
  // paying for. `upstream` must satisfy it.
  const root = fixture({ git: true, remote: { name: "upstream", url: "https://example.invalid/x.git" }, stateFiles: 1 });
  try {
    const r = new Reporter();
    await checkWorkspace({ ws: ws(root), sidecars: [], reporter: r });
    assert.equal(entryFor(r).kind, "pass", "a non-origin remote still backs the state");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an EMPTY state directory is not flagged — nothing there to lose", async () => {
  // This fired on `Khushboo` and `Rishabh` in its first version: doc-only husks
  // carrying an empty propagation/state/. Two false hits out of three would have
  // trained the reader to skip the check, costing the one real hit.
  const root = fixture({ git: true, stateFiles: 0 });
  try {
    const r = new Reporter();
    await checkWorkspace({ ws: ws(root), sidecars: [], reporter: r });
    assert.equal(entryFor(r), undefined, "no state, no verdict");
    // Scoped to THIS check, not to `r.problems`. The fixture has no ledger, so
    // checkWorkspace's other checks legitimately fail and the run-level count is
    // 2 — asserting 0 there tested the fixture's completeness, not this check.
    assert.ok(
      !r.entries.some((e) => e.kind === "fail" && /remote/.test(e.label)),
      "no remote-related failure may be raised for a workspace holding no state",
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a non-git directory reports UNKNOWN, never a clean pass", async () => {
  // rule:discernment-checks §2. "git could not run here" and "this state is
  // backed" must not share an output.
  const root = fixture({ git: false, stateFiles: 1 });
  try {
    const r = new Reporter();
    await checkWorkspace({ ws: ws(root), sidecars: [], reporter: r });
    assert.equal(entryFor(r), undefined, "it must not render as a pass");
    assert.ok(
      r.entries.some((e) => e.kind === "info" && /durability unknown/.test(e.detail ?? "")),
      "and it must say durability is unknown rather than stay silent",
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
