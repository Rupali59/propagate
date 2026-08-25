/**
 * doctor's ledger-era census — the failing case, constructed.
 *
 * The check is "no ledger line bypassed appendRow". Its precision is the whole
 * point, so both halves are asserted here:
 *
 *   NOT-YET-FROZEN ledger (no archive/) + unstamped lines  -> INFO, exit 0.
 *     Pre-freeze, an unstamped line is v1 history awaiting Phase D. It is
 *     indistinguishable from a bypassing writer, and failing on an ambiguity
 *     asserts something unknowable.
 *
 *   FROZEN ledger (archive/ present) + an unstamped live line -> FAIL.
 *     Once the archive exists every v1 line is in it, so an unstamped line in
 *     the live ledger has exactly one meaning: something wrote it without going
 *     through `appendRow`, which stamps `schema: 2`.
 *
 * Without the second case the check could never fail and would report success
 * forever (GOTCHAS G1, rule:discernment-checks §1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

const CLOSED_V1 = [
  { id: "001", type: "drift", source: "a.md", status: "open" },
  { id: "001", type: "status_change", status: "done", closed_by: "drain" },
];

/**
 * @param {{frozen: boolean, liveLines: object[]}} opts
 */
async function makeWorkspace({ frozen, liveLines }) {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-ledger-era-"));
  const prop = path.join(root, "ws", "propagation");
  await mkdir(prop, { recursive: true });
  await writeFile(path.join(root, "ws", ".propagates.yml"), "workspace: true\nsources: {}\n");
  await writeFile(
    path.join(prop, "ledger.jsonl"),
    liveLines.map((r) => JSON.stringify(r)).join("\n") + (liveLines.length ? "\n" : ""),
  );
  await writeFile(path.join(prop, "ledger.md"), "# Ledger\n");
  if (frozen) {
    await mkdir(path.join(prop, "archive"), { recursive: true });
    await writeFile(
      path.join(prop, "archive", "ledger-v1-2026-08-24.jsonl"),
      CLOSED_V1.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }
  return root;
}

function runDoctor(root) {
  return spawnSync("node", [CLI_PATH, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
  });
}

test("an unstamped line in a NOT-YET-FROZEN ledger is informational, never a failure", async () => {
  const root = await makeWorkspace({ frozen: false, liveLines: CLOSED_V1 });
  const r = runDoctor(root);
  assert.match(
    r.stdout,
    /not yet frozen/,
    "a ledger awaiting the freeze must SAY so — silence would make pending indistinguishable from done",
  );
  assert.doesNotMatch(
    r.stdout,
    /bypassed appendRow.*unstamped line/s,
    "pre-freeze lines must not be reported as bypassing writers; that is the ambiguity the freeze resolves",
  );
});

test("an unstamped line in a FROZEN ledger fails the check — the constructed failing case", async () => {
  const root = await makeWorkspace({
    frozen: true,
    // The archive exists, so this line cannot be v1 history: something wrote it
    // to the live ledger without going through appendRow.
    liveLines: [{ id: "009", type: "drift", source: "sneaky.md", status: "done" }],
  });
  const r = runDoctor(root);
  assert.match(
    r.stdout,
    /no ledger line bypassed appendRow/,
    "the check must appear in doctor's output at all",
  );
  assert.match(
    r.stdout,
    /unstamped line\(s\) in a FROZEN ledger/,
    "the failure must name WHY it fired, not merely go red",
  );
  assert.notEqual(r.status, 0, "doctor must exit non-zero when a writer bypassed appendRow");
});

test("a frozen ledger whose live lines are all stamped passes", async () => {
  const root = await makeWorkspace({
    frozen: true,
    liveLines: [{ schema: 2, id: "009", type: "drift", source: "ok.md", status: "done" }],
  });
  const r = runDoctor(root);
  assert.doesNotMatch(
    r.stdout,
    /unstamped line\(s\) in a FROZEN ledger/,
    "a correctly-stamped live ledger must not trip the bypass check",
  );
});
