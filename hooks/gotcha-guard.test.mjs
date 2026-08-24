/**
 * gotcha-guard — behaviour tests.
 *
 * Run: `npm test`, or `node --test hooks/gotcha-guard.test.mjs` for this file alone.
 * NOT `node --test hooks/` — Node 25 resolves a bare directory as a module and dies
 * with MODULE_NOT_FOUND before running anything. And until 2026-08-22 these tests were
 * outside `npm test`'s glob entirely, so all nine passed locally and ran nowhere.
 *
 * WHY THIS FILE EXISTS. The guard shipped 2026-08-17 with a `--selftest` that
 * checked *index integrity* — every trigger compiles, every trigger matches its
 * own `**Fires on:**` literal — and nothing that checked what the operator
 * actually receives. So a `.slice(0, 6)` on the body went out truncating entries
 * mid-sentence and **dropping the `**Instead:**` remedy line entirely**: the
 * guard spent the interruption and withheld the payoff. The fix for that then
 * introduced a second bug, reordering multi-line remedies above their own
 * heading. Neither was caught by the selftest, because the selftest never looked
 * at the rendered output.
 *
 * `rule:safety-flag-needs-a-test`: a claim about behaviour ships with a test
 * that constructs the input making it fail. These go through stdin/stdout — the
 * real interface — rather than importing internals, so they test delivery and
 * not just parsing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./gotcha-guard.mjs", import.meta.url));

/** Run the guard against a fixture index, isolated from the real one. */
function fire(command, { globalIndex, ceiling, tool = "Bash" }) {
  const input = tool === "Bash"
    ? { tool_name: "Bash", tool_input: { command } }
    : { tool_name: tool, tool_input: { file_path: command } };
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: "utf8",
    cwd: ceiling,
    env: {
      ...process.env,
      GOTCHA_GUARD_GLOBAL: globalIndex,
      GOTCHA_GUARD_CEILING: ceiling,
      GOTCHA_GUARD_LOG: path.join(ceiling, "log"),
    },
  });
  let payload = null;
  if (r.stdout.trim()) { try { payload = JSON.parse(r.stdout); } catch { /* leave null */ } }
  return { status: r.status, text: payload?.systemMessage ?? "", payload };
}

async function fixture(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-test-"));
  const globalIndex = path.join(dir, "index.md");
  await writeFile(globalIndex, body);
  return { dir, globalIndex, ceiling: dir };
}

const ENTRY_WITH_LONG_REMEDY = `# fixture

### F1 · a hazard with a long body and a two-line remedy
**Trigger:** \`dangercmd\`
**Fires on:** \`dangercmd --now\`
line one of the explanation
line two of the explanation
line three of the explanation
line four of the explanation
line five of the explanation
line six of the explanation
line seven of the explanation
line eight of the explanation
line nine of the explanation
**Instead:** do the safe thing, which takes two lines to describe
and this is the second line of that remedy.
`;

// ---------------------------------------------------------------------------
// The bug that shipped
// ---------------------------------------------------------------------------

test("the remedy survives truncation of a long body", async (t) => {
  const f = await fixture(ENTRY_WITH_LONG_REMEDY);
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  const { text } = fire("dangercmd --now", f);

  // FAILING INPUT: restore `.slice(0, 6)` over the whole body. The nine
  // explanation lines fill the budget and **Instead:** never appears — which is
  // exactly what shipped.
  assert.match(text, /\*\*Instead:\*\* do the safe thing/, "the remedy must be delivered");
  assert.match(text, /second line of that remedy/, "including its continuation lines");
});

/**
 * SHORT body, multi-line remedy — the shape of the real G-G entry, and the only
 * shape that exercises ORDERING.
 *
 * With a long body the filter-based bug shows up as a *dropped* continuation
 * (the budget eats it) and the ordering assertion fails for the wrong reason.
 * Nine explanation lines hid the defect this test is named after; three do not.
 */
const ENTRY_SHORT_BODY_LONG_REMEDY = `# fixture

### F5 · short body, two-line remedy
**Trigger:** \`reordercmd\`
**Fires on:** \`reordercmd\`
**Signal:** something visible.
**Cost:** one afternoon.
**Instead:** do the safe thing, and when a sweep says something implausible
about a repo you know is fine, suspect the path base.
`;

test("a multi-line remedy is not reordered above its own heading", async (t) => {
  const f = await fixture(ENTRY_SHORT_BODY_LONG_REMEDY);
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  const { text } = fire("reordercmd", f);
  const headingAt = text.indexOf("**Instead:**");
  const continuationAt = text.indexOf("suspect the path base");

  // FAILING INPUT: classify remedy lines with `.filter(isRemedy)` instead of
  // slicing from the first marker. The continuation is not itself a marker, so
  // it lands in `rest` and prints ABOVE the heading — nonsense, and it is what
  // the first fix did.
  assert.ok(headingAt !== -1 && continuationAt !== -1, "both parts present");
  assert.ok(headingAt < continuationAt, "the remedy heading must precede its continuation");
});

test("truncation is announced, never silent", async (t) => {
  const f = await fixture(ENTRY_WITH_LONG_REMEDY);
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const { text } = fire("dangercmd --now", f);
  assert.match(text, /more line\(s\)/, "a dropped line must say it was dropped (G2)");
});

test("a short entry is delivered whole, with no truncation notice", async (t) => {
  const f = await fixture(
    "### F2 · short\n**Trigger:** `shortcmd`\n**Fires on:** `shortcmd`\nonly one line.\n**Do:** the thing.\n",
  );
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const { text } = fire("shortcmd", f);
  assert.match(text, /only one line/);
  assert.match(text, /\*\*Do:\*\* the thing/);
  assert.doesNotMatch(text, /more line\(s\)/, "nothing was dropped, so say nothing");
});

// ---------------------------------------------------------------------------
// Delivery contract
// ---------------------------------------------------------------------------

test("output goes to stdout as PreToolUse additionalContext, not stderr", async (t) => {
  const f = await fixture(ENTRY_WITH_LONG_REMEDY);
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  // Measured 2026-08-17: stderr on exit 0 reaches nobody. The hook fired,
  // matched, logged `hits=1`, and the model saw nothing.
  const { payload, status } = fire("dangercmd --now", f);
  assert.equal(status, 0, "informs, never blocks");
  assert.ok(payload, "stdout must be JSON");
  assert.equal(payload.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.ok(payload.hookSpecificOutput?.additionalContext, "the model-facing channel");
  assert.ok(payload.systemMessage, "and the human-facing one");
  assert.equal(
    payload.hookSpecificOutput.additionalContext,
    payload.systemMessage,
    "both parties get the same text — a hazard delivered to one only is half-delivered",
  );
});

test("no match produces no output and exit 0", async (t) => {
  const f = await fixture(ENTRY_WITH_LONG_REMEDY);
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const r = fire("ls -la", f);
  assert.equal(r.status, 0);
  assert.equal(r.text, "", "silence is correct for the overwhelming majority of calls");
});

test("a malformed payload never blocks the tool call", async () => {
  const r = spawnSync(process.execPath, [GUARD], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0, "fail open — this guard must never be why a command did not run");
});

test("Edit and Write match on file_path, not command", async (t) => {
  const f = await fixture("### F3 · path hazard\n**Trigger:** `atom\\.js`\n**Fires on:** `src/lib/atom.js`\nhazard.\n**Do:** care.\n");
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.match(fire("src/lib/atom.js", { ...f, tool: "Edit" }).text, /path hazard/);
  assert.equal(fire("src/lib/other.js", { ...f, tool: "Write" }).text, "", "non-matching path is silent");
});

test("an unknown tool is ignored rather than matched against an empty subject", async (t) => {
  const f = await fixture("### F4 · matches empty\n**Trigger:** `.*`\n**Fires on:** `anything`\nbody.\n**Do:** x.\n");
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "https://x" } }),
    encoding: "utf8",
    env: { ...process.env, GOTCHA_GUARD_GLOBAL: f.globalIndex, GOTCHA_GUARD_CEILING: f.ceiling, GOTCHA_GUARD_LOG: path.join(f.dir, "log") },
  });
  assert.equal(r.stdout.trim(), "", "a `.*` trigger must not fire on a tool with no subject");
});

// ---------------------------------------------------------------------------
// module hygiene — importing the hook must not RUN the hook
// ---------------------------------------------------------------------------

test("importing the guard does not execute it", async () => {
  // The guard runs `main()` at module scope, which reads stdin and calls
  // process.exit. An `isDirectRun` check gates that, so the reconcile path can
  // import the module for its exports.
  //
  // Without the gate the failure is not an error, it is a HANG: an importer has
  // no hook payload to send, so `readFileSync(0)` blocks forever and takes the
  // importing process (doctor) with it. A hang reads as "slow", gets retried,
  // and is diagnosed last — so it is asserted with a hard timeout rather than
  // trusted to fail fast.
  const r = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(GUARD)}).then(() => { console.log("IMPORTED"); });`],
    { encoding: "utf8", timeout: 10_000, input: "" },
  );
  assert.equal(r.signal, null, "importing the guard timed out — the entrypoint gate is not holding");
  assert.equal(r.status, 0, `import exited ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /IMPORTED/, "the import must resolve, not exit early");
});

// ---------------------------------------------------------------------------
// The entrypoint guard must survive a symlinked invocation
// ---------------------------------------------------------------------------

test("invoked through a SYMLINK the guard still runs — it must not decide it was imported", async (t) => {
  // The defect this pins, found by review 2026-08-23 and reproduced before fixing:
  // Node's ESM loader realpaths `import.meta.url` but leaves `process.argv[1]` as
  // typed, so `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` was FALSE
  // through a symlink. The guard concluded "imported", ran nothing, and exited 0.
  //
  // That is the served path, not a hypothetical: `skills-marketplace/propagate` is a
  // symlink to `../propagate`, and hooks.json invokes
  // `${CLAUDE_PLUGIN_ROOT}/hooks/gotcha-guard.mjs`. Both the guard and its own
  // --selftest liveness probe were dead there, reporting success.
  //
  // Asserts OUTPUT, not exit code: the broken version also exited 0. Exit code was
  // exactly what made it invisible (rule:discernment-checks §1).
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { fileURLToPath } = await import("node:url");

  const real = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const dir = await mkdtemp(path.join(tmpdir(), "guard-symlink-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Symlink the whole hooks dir, mirroring how the marketplace links the plugin root.
  const link = path.join(dir, "hooks-link");
  await symlink(real, link);

  const viaLink = execFileSync(process.execPath, [path.join(link, "gotcha-guard.mjs"), "--selftest"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: dir },
  });
  assert.match(
    viaLink,
    /entries|guard can fire|source/i,
    "a symlinked invocation produced NO output — the entrypoint guard treated it as an import",
  );
});

