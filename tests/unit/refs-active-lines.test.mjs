/**
 * `readActiveLines` — the one C2 hygiene lib C1d.4 genuinely depends on.
 *
 * WHY IT CANNOT WAIT. `is_active_line` is a field `docs/REFERENCE.md:106-110`
 * requires, and it is NOT derivable from git: it says which branch a project
 * deploys from, which is a decision recorded in
 * `docs/conventions/CONTEXT-BUDGET.md` under `[active_lines]`.
 *
 * Vipin Kaushik's live snapshot flags 7 refs correctly. Regenerating without
 * this reader emits `null` for all 36 — a file that passes conformance and is
 * quietly worse than the one it replaced.
 *
 * `rule:conventions/WORKTREES.md` is explicit that the active line comes from
 * this config and NOT from probing, and records an incident where a probe named
 * a stale, long-abandoned branch as the active one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readActiveLines } from "../../lib/refs/active-lines.mjs";

async function workspaceWith(t, budgetBody) {
  const root = await mkdtemp(path.join(tmpdir(), "active-lines-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (budgetBody !== null) {
    await mkdir(path.join(root, "docs", "conventions"), { recursive: true });
    await writeFile(path.join(root, "docs", "conventions", "CONTEXT-BUDGET.md"), budgetBody);
  }
  return root;
}

const BUDGET = `# Context budget

Some prose first.

\`\`\`toml
[caps]
"CLAUDE.md" = 220

[active_lines]
workspace = "main"
VipinKaushik = "production"
"VipinKaushik-mb" = "main"
astroacharya = "main"

[canonical_paths]
foo = "bar"
\`\`\`
`;

test("reads [active_lines], tolerating quoted and bare keys alike", async (t) => {
  const root = await workspaceWith(t, BUDGET);
  const r = readActiveLines(root);
  assert.deepEqual(r.lines, {
    workspace: "main",
    VipinKaushik: "production",
    "VipinKaushik-mb": "main",
    astroacharya: "main",
  });
  assert.ok(r.source.endsWith("CONTEXT-BUDGET.md"));
  assert.equal(r.reason, undefined, "a successful read carries no reason");
});

test("stops at the next section — [canonical_paths] is not an active line", async (t) => {
  const root = await workspaceWith(t, BUDGET);
  const r = readActiveLines(root);
  assert.ok(!("foo" in r.lines), `bled into the next section: ${JSON.stringify(r.lines)}`);
});

test("NO CONFIG is an attributable absence, not an empty result", async (t) => {
  // Most workspaces have no CONTEXT-BUDGET.md. That is a normal state, and it
  // must be distinguishable from "the file exists and declares nothing" —
  // otherwise every ref silently gets is_active_line: null and nobody can say
  // whether that is correct (rule:discernment-checks §2).
  const root = await workspaceWith(t, null);
  const r = readActiveLines(root);
  assert.deepEqual(r.lines, {});
  assert.match(r.reason, /not found|no CONTEXT-BUDGET/i, `must say WHY: ${JSON.stringify(r)}`);
});

test("a config with no [active_lines] section is a DIFFERENT absence", async (t) => {
  const root = await workspaceWith(t, "# Budget\n\n```toml\n[caps]\nx = 1\n```\n");
  const r = readActiveLines(root);
  assert.deepEqual(r.lines, {});
  assert.match(r.reason, /active_lines/i, "the file was read; the section is what is missing");
});

test("a malformed config yields a reason, never a throw", async (t) => {
  // A throw here would take doctor and migrate-refs down with it.
  const root = await workspaceWith(t, "# Budget\n\nno fenced block at all\n");
  let r;
  assert.doesNotThrow(() => { r = readActiveLines(root); });
  assert.deepEqual(r.lines, {});
  assert.ok(r.reason, "and it must say what it could not find");
});

test("the REAL Vipin Kaushik config yields the 7 projects its snapshot flags", () => {
  // The live case this exists for. If this drifts, the regenerated snapshot
  // silently loses flags and nothing else notices.
  const vk = "/Users/rupali.b/Documents/GitHub/Vipin Kaushik";
  const r = readActiveLines(vk);
  if (r.reason) return; // not this machine
  assert.equal(Object.keys(r.lines).length, 7, `expected 7 declared active lines, got ${JSON.stringify(r.lines)}`);
  assert.equal(r.lines.VipinKaushik, "production", "VK deploys from production, not main — the case a probe gets wrong");
  assert.equal(r.lines.workspace, "main");
});
