/**
 * The verdict write path, and the identity that lets an UNPAIRED entry carry one.
 *
 * WHAT WAS MISSING. Phase 2a poses questions; nothing could record an answer.
 * There was no `appendClaim` caller anywhere under `commands/`, and an unpaired
 * corpus entry carried `{rule, file, line, reason}` — no hash, so no verdict
 * could key to it. Together that meant the lane could never converge: the same
 * 15 entries re-report on every run, 10 of them unpairable, with no way to say
 * "checked, this one is a false positive". A worklist that cannot be drained
 * reads as coverage while catching nothing.
 *
 * WHY THE DRY-RUN TESTS ARE THE LOAD-BEARING ONES. `rule:safety-flag-needs-a-test`
 * records three incidents in this tree where a command documented as a preview
 * wrote to an append-only store anyway — the worst cost 11 spurious events and 3
 * silently-closed worklist items. So these assert the STORE, byte for byte,
 * rather than asserting that the output contains the word "would".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unpairedSha } from "../../lib/claims/restate.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Concatenate every byte of the claim store — the artifact, not the report. */
async function storeSnapshot(stateDir) {
  const dir = path.join(stateDir, "claims");
  if (!existsSync(dir)) return "";
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  let out = "";
  for (const f of files) out += await readFile(path.join(dir, f), "utf8");
  return out;
}

function runVerdict(stateDir, stdin, args = []) {
  return spawnSync(process.execPath, [CLI, "claims", "verdict", ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir },
  });
}

const ok = () => ({ file: "/tmp/doc.md", block_sha: sha("block"), kind: "policy", against: sha("fact"), finding: "unrelated" });

test("WITHOUT --apply the claim store is byte-identical — the preview writes nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-dry-"));
  const before = await storeSnapshot(dir);
  const r = runVerdict(dir, JSON.stringify([ok()]));
  assert.equal(r.status, 0, `dry run must exit 0:\n${r.stdout}${r.stderr}`);
  assert.equal(await storeSnapshot(dir), before, "a run without --apply must not touch the store");
});

test("--apply writes, and the store changes — proving the dry-run test above measures something", async () => {
  // Without this, the assertion above would also pass on a command that can
  // never write at all. A check that cannot fail is worse than no check.
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-apply-"));
  const before = await storeSnapshot(dir);
  const r = runVerdict(dir, JSON.stringify([ok()]), ["--apply"]);
  assert.equal(r.status, 0, `apply must exit 0:\n${r.stdout}${r.stderr}`);
  assert.notEqual(await storeSnapshot(dir), before, "--apply must actually write");
});

test("one bad row refuses the WHOLE batch — an append-only store cannot be half-written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-atomic-"));
  const before = await storeSnapshot(dir);
  const r = runVerdict(dir, JSON.stringify([ok(), { ...ok(), block_sha: "nothex" }]), ["--apply"]);
  assert.equal(r.status, 2, "a batch containing an invalid row must be refused");
  assert.equal(await storeSnapshot(dir), before, "the VALID row must not have been written either");
});

test("`finding` without `against` is refused — a half-recorded judgement reads as a whole one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-half-"));
  const v = ok(); delete v.against;
  const r = runVerdict(dir, JSON.stringify([v]), ["--apply"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /without "against"|"finding" without/);
});

test("unparseable stdin names the line, it does not die with a bare parse error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-parse-"));
  const r = runVerdict(dir, '{"file":"a"}\nnot json at all\n', ["--apply"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /line 2/, "the failure must say WHICH line, not just that parsing failed");
});

test("unpairedSha is stable across line moves but re-opens when the rule text changes", () => {
  // The identity deliberately excludes the line number: "this corpus entry is
  // not a restatement" does not stop being true because a paragraph was
  // inserted above it. It DOES include the rule's fact hash, so editing the
  // rule re-opens the judgement — the same property pairSha has.
  const e1 = { rule: "tool-priority", file: "/tmp/CLAUDE.md", line: 25 };
  const e2 = { rule: "tool-priority", file: "/tmp/CLAUDE.md", line: 400 };
  const factA = { sha: sha("rule text A") };
  const factB = { sha: sha("rule text B") };

  assert.equal(unpairedSha(e1, factA), unpairedSha(e2, factA), "a moved line must not re-open the judgement");
  assert.notEqual(unpairedSha(e1, factA), unpairedSha(e1, factB), "changing the rule's text MUST re-open it");
  assert.notEqual(
    unpairedSha(e1, factA),
    unpairedSha({ ...e1, file: "/tmp/other.md" }, factA),
    "two files must not collide onto one identity",
  );
});

test("unpairedSha yields a valid block_sha — 64 lowercase hex, so a verdict can key to it", () => {
  // The whole point: an unpaired entry must be recordable through the SAME
  // schema, without fabricating a field to fit it.
  const s = unpairedSha({ rule: "r", file: "/tmp/f.md", line: 1 }, { sha: sha("x") });
  assert.match(s, /^[0-9a-f]{64}$/);
});

test("a fact-less unpaired entry still gets an identity, distinct from a fact-bearing one", async () => {
  // Rule missing or unreadable: there is no fact to judge against. That entry
  // is still identifiable, and must not collide with the same file judged
  // against a real rule.
  const e = { rule: "gone", file: "/tmp/f.md", line: 3 };
  assert.match(unpairedSha(e, null), /^[0-9a-f]{64}$/);
  assert.notEqual(unpairedSha(e, null), unpairedSha(e, { sha: sha("real") }));
  await mkdir(path.join(await mkdtemp(path.join(tmpdir(), "noop-")), "x"), { recursive: true });
});
