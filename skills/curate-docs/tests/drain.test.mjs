/**
 * Draining is the only irreversible-ish step, so the gate gets the same treatment as
 * `state`: the unsafe path must be UNREACHABLE without --apply, and the two preconditions
 * must be ENFORCED rather than documented.
 *
 * You cannot delete what you have not declared dead, and you cannot delete something another
 * document depends on for its only reachability. Ordering the pipeline is worth nothing if
 * the tool does not hold the order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setStatus } from "../lib/state.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
const git = (d, ...a) => execFileSync("git", ["-C", d, ...a], { stdio: ["ignore", "pipe", "ignore"] });

function snapshot(dir) {
  const parts = [];
  (function rec(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git") continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) rec(f);
      else parts.push(`${path.relative(dir, f)}|${statSync(f).size}|${readFileSync(f, "utf8")}`);
    }
  })(dir);
  return parts.join("\n--\n");
}

/** hub -> A ; A -> B ; plus a standalone C that nothing depends on. */
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), "cd-drain-"));
  git(d, "init", "-q"); git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  mkdirSync(path.join(d, "docs"));
  writeFileSync(path.join(d, "STATE.md"), "# hub\n- [A](./docs/a.md)\n- [C](./docs/c.md)\n");
  writeFileSync(path.join(d, "docs/a.md"), "# A\nsee [B](./b.md)\n");
  writeFileSync(path.join(d, "docs/b.md"), "# B\n");
  writeFileSync(path.join(d, "docs/c.md"), "# C\n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "init");
  return d;
}

const run = (d, ...a) => {
  try { return { code: 0, out: execFileSync("node", [CLI, ...a], { encoding: "utf8", cwd: d, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
};

test("WITHOUT --apply, drain removes nothing — every byte of the tree survives", () => {
  const d = repo();
  setStatus(path.join(d, "docs/c.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  git(d, "add", "-A"); git(d, "commit", "-qm", "declare");
  const before = snapshot(d);
  const r = run(d, "drain", path.join(d, "docs/c.md"));
  assert.equal(r.code, 0);
  assert.match(r.out, /WOULD RUN/);
  assert.equal(snapshot(d), before, "the preview must not perform the deletion it previews");
});

test("drain REFUSES a doc whose status was never declared", () => {
  const d = repo();
  const before = snapshot(d);
  const r = run(d, "drain", path.join(d, "docs/c.md"), "--apply");
  assert.equal(r.code, 5);
  assert.match(r.out, /status "active"/);
  assert.match(r.out, /Salvage happens between declaring and draining/);
  assert.equal(snapshot(d), before, "a refusal must not half-apply");
});

test("drain REFUSES a doc that is the only caller of another — that is the cascade", () => {
  const d = repo();
  setStatus(path.join(d, "docs/a.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  git(d, "add", "-A"); git(d, "commit", "-qm", "declare");
  const before = snapshot(d);
  const r = run(d, "drain", path.join(d, "docs/a.md"), "--apply");
  assert.equal(r.code, 5);
  assert.match(r.out, /only document citing 1/);
  assert.match(r.out, /docs\/b\.md/);
  assert.equal(snapshot(d), before);
});

test("with both preconditions met and --apply, the doc is removed via git", () => {
  const d = repo();
  setStatus(path.join(d, "docs/c.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  git(d, "add", "-A"); git(d, "commit", "-qm", "declare");
  const r = run(d, "drain", path.join(d, "docs/c.md"), "--apply");
  assert.equal(r.code, 0);
  assert.match(r.out, /drained/);
  assert.ok(!readdirSync(path.join(d, "docs")).includes("c.md"));
  // git rm stages the removal, so the content is recoverable from history.
  assert.match(git(d, "log", "--all", "--oneline").toString(), /declare/);
});

test("impact names the sole-caller relationship BEFORE anything is done", () => {
  const d = repo();
  const r = run(d, "impact", path.join(d, "docs/a.md"), "--json");
  assert.equal(r.code, 0);
  const i = JSON.parse(r.out);
  assert.deepEqual(i.soleCallerOf.map((p) => path.basename(p)), ["b.md"]);
  assert.deepEqual(i.callers.map((p) => path.basename(p)), ["STATE.md"]);
});

test("impact on a doc nothing depends on says so plainly", () => {
  const d = repo();
  const i = JSON.parse(run(d, "impact", path.join(d, "docs/c.md"), "--json").out);
  assert.deepEqual(i.soleCallerOf, []);
});

test("drain REFUSES a doc that CODE cites — the graph only sees .md, code citations are invisible to it", () => {
  // Found on a real triage: docs/plans/2026-07-10-jyotish-entity-ontology.md was cited by
  // FIVE .ts files as the authority for a live resolver, and read as a drainable orphan
  // because no markdown pointed at it. Deleting it would have broken five code references
  // to a spec that still governs running behaviour.
  const d = repo();
  writeFileSync(path.join(d, "impl.ts"), "// spec: docs/c.md\nexport const x = 1;\n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "code cites the doc");
  setStatus(path.join(d, "docs/c.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  git(d, "add", "-A"); git(d, "commit", "-qm", "declare");
  const before = snapshot(d);
  const r = run(d, "drain", path.join(d, "docs/c.md"), "--apply");
  assert.equal(r.code, 5);
  assert.match(r.out, /cited from code/i);
  assert.match(r.out, /impl\.ts/);
  assert.equal(snapshot(d), before);
});

test("a doc no code cites is still drainable — the check must not refuse everything", () => {
  const d = repo();
  writeFileSync(path.join(d, "impl.ts"), "export const x = 1;\n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "code");
  setStatus(path.join(d, "docs/c.md"), { status: "archived", because: "shipped", on: "2026-08-19" }, { apply: true });
  git(d, "add", "-A"); git(d, "commit", "-qm", "declare");
  assert.equal(run(d, "drain", path.join(d, "docs/c.md"), "--apply").code, 0);
});
